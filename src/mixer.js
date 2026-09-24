// Shared mixing engine — the transition core used by the Zvuk-style player
// (player.js) and exercised offline by the lab/ scripts. Keeping it in one place is
// deliberate: the earlier phase regressed when tuned constants drifted between
// copies, so every deck EQ curve, the equal-power crossfade, the bass swap and the
// tempo lock live here once and are verified once (lab/, offline render).
import { localEnergy } from './analysis.js';

export const TRANSITION_BARS = 16;
export const MAX_TEMPO_STRETCH = 0.06; // ±6 % per deck — beyond this the sync drifts audibly
export const BASS_CUT_DB = -30;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Equal-power crossfade curves: summed power stays constant, so there is no
// volume dip in the middle of the transition the way a linear crossfade has.
const EQUAL_POWER_STEPS = 128;
const fadeCurve = (kind) => {
  const curve = new Float32Array(EQUAL_POWER_STEPS);
  for (let i = 0; i < EQUAL_POWER_STEPS; i += 1) {
    const t = i / (EQUAL_POWER_STEPS - 1);
    curve[i] = kind === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2);
  }
  return curve;
};
export const FADE_IN_CURVE = fadeCurve('in');
export const FADE_OUT_CURVE = fadeCurve('out');
export const scaleCurve = (curve, factor) => curve.map((value) => value * factor);

// Split-the-difference tempo lock: instead of stretching only B onto A, both decks
// meet at the geometric-mean tempo. That halves the pitch shift each track takes
// and keeps the whole transition inside the ±MAX_TEMPO_STRETCH budget.
export function tempoPlan(aPeriod, bPeriod) {
  const common = Math.sqrt(aPeriod * bPeriod);
  const rateA = clamp(aPeriod / common, 1 - MAX_TEMPO_STRETCH, 1 + MAX_TEMPO_STRETCH);
  const rateB = clamp(bPeriod / common, 1 - MAX_TEMPO_STRETCH, 1 + MAX_TEMPO_STRETCH);
  const feasible = Math.abs(aPeriod / common - 1) <= MAX_TEMPO_STRETCH + 1e-6
    && Math.abs(bPeriod / common - 1) <= MAX_TEMPO_STRETCH + 1e-6;
  return { rateA, rateB, common, commonBpm: 60 / common, feasible };
}

// One mixer channel: buffer source → 3-band EQ → gain → output. The caller sets
// playbackRate and starts the source; scheduleCrossfade drives the EQ and gain.
export function makeChannel(context, buffer, output) {
  const source = context.createBufferSource();
  source.buffer = buffer;
  const low = context.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 230;
  const mid = context.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1150; mid.Q.value = 0.7;
  const high = context.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 4400;
  const gain = context.createGain();
  source.connect(low).connect(mid).connect(high).connect(gain).connect(output);
  return { source, low, mid, high, gain };
}

export function scheduleValue(param, at, from, to, duration) {
  param.cancelScheduledValues(at);
  param.setValueAtTime(from, at);
  param.linearRampToValueAtTime(to, at + duration);
}

// Drives a low-shelf gain (dB) as the inverse of the channel's own crossfade gain over
// [x0, x1] (fractions of the transition), so the kick and bass hold their solo level for
// as long as this channel owns the low end. Without it the equal-power fade drags the lone
// kick down to -3 dB by the swap while the other channel's bass is still cut — and bass
// being most of a house track's energy, the whole blend sagged by ~1.4 dB in the middle.
// Piecewise-linear because a curve event can't be split around the swap ramp.
const BASS_HOLD_STEPS = 16;
function holdBass(param, startTime, transitionSeconds, x0, x1, gainAt, firstIsRamp) {
  for (let i = 0; i <= BASS_HOLD_STEPS; i += 1) {
    const x = x0 + ((x1 - x0) * i) / BASS_HOLD_STEPS;
    const db = -20 * Math.log10(gainAt(x));
    const at = startTime + x * transitionSeconds;
    if (i === 0 && !firstIsRamp) param.setValueAtTime(db, at);
    else param.linearRampToValueAtTime(db, at);
  }
}

// Soft-clip safety stage after the limiter. DynamicsCompressor is not a brickwall
// limiter — its 3 ms attack lets the first transient of a hot overlap through, and a
// dense pair measured as high as +0.5 dBFS over. Identity up to CLIP_KNEE (so anything
// the limiter already tamed passes untouched), then a sine-shaped knee that reaches its
// ceiling with zero slope exactly at full scale: the curve is smooth all the way, and
// input beyond ±1 (which a WaveShaper clamps) lands on the flat part rather than
// creating a step.
const CLIP_KNEE = 0.85;
const CLIP_CEILING = CLIP_KNEE + (1 - CLIP_KNEE) * (2 / Math.PI);
const SOFT_CLIP_CURVE = (() => {
  const points = 2049; // odd, so 0 sits on a sample
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    const x = (2 * i) / (points - 1) - 1;
    const a = Math.abs(x);
    const y = a <= CLIP_KNEE
      ? a
      : CLIP_KNEE + (1 - CLIP_KNEE) * (2 / Math.PI) * Math.sin((Math.PI / 2) * ((a - CLIP_KNEE) / (1 - CLIP_KNEE)));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
})();

// A master gain feeding a limiter, then the soft-clip safety, into the destination.
// The two decks overlap at full level mid-transition, so the limiter catches peaks
// above ~-1.5 dBFS and the soft clip guarantees nothing leaves above CLIP_CEILING.
export function makeMaster(context, level = 0.9) {
  const master = context.createGain();
  master.gain.value = level;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-1.5, context.currentTime);
  limiter.knee.setValueAtTime(0, context.currentTime);
  limiter.ratio.setValueAtTime(20, context.currentTime);
  limiter.attack.setValueAtTime(0.003, context.currentTime);
  limiter.release.setValueAtTime(0.25, context.currentTime);
  const softClip = context.createWaveShaper();
  softClip.curve = SOFT_CLIP_CURVE;
  master.connect(limiter).connect(softClip).connect(context.destination);
  return master;
}

// How many trailing phrase boundaries to weigh before committing. Deliberately just
// one phrase back from the naive last fit, not more: a real track's second-to-last
// phrase gives a bounded, ~one-phrase-length second opinion, whereas letting the
// search range further back can find an earlier window that scores as flatter simply
// because it's a different section of the arrangement (a first drop, a loop) — a
// clean number that has nothing to do with the last window actually being unsafe, and
// on a short track that "win" can drag the exit back by a third of the track. Bounding
// the lookback keeps the worst case predictable across arbitrary uploaded tracks,
// which matters more here than finding the single best window in the whole file.
const OUTRO_SEARCH_PHRASES = 2;
const OUTRO_LATENESS_BIAS = 0.4; // per-phrase penalty for cutting earlier than the latest fit

// How flat a transition-length window's bar-to-bar energy is, read straight off the
// decoded buffer (already in memory by the time a track is scheduled — no separate
// analysis pass needed). High when the section has settled; low when the window
// itself crosses a structural change (a build-up ramping, a drop landing), so scoring
// this steers away from cutting across one. Mirrors chooseEntryPoint's percussive-
// phrase heuristic on the incoming side, but for "won't cut across a change" rather
// than "kicks hard".
function outroStability(data, sampleRate, beats, index, phraseBeats) {
  const barEnergies = [];
  for (let bar = 0; bar < phraseBeats; bar += 4) {
    let energy = 0;
    for (let step = 0; step < 4; step += 1) {
      const beat = beats[index + bar + step];
      if (beat === undefined) return -Infinity; // window runs off the end of the beat grid
      energy += localEnergy(data, sampleRate, beat, 0.12);
    }
    barEnergies.push(energy / 4);
  }
  let maxSwing = 0;
  for (let i = 1; i < barEnergies.length; i += 1) {
    maxSwing = Math.max(maxSwing, Math.abs(barEnergies[i] - barEnergies[i - 1]));
  }
  const mean = barEnergies.reduce((sum, value) => sum + value, 0) / barEnergies.length;
  return mean / Math.max(maxSwing, mean * 0.08, 1e-6);
}

// Latest real phrase downbeat that still leaves room for the whole transition, so the
// outgoing track's outro starts on a musical boundary instead of a bar counted off the
// grid origin. Among the last few candidates, prefers whichever window's energy stays
// flattest across the transition span — unless an earlier one is clearly more settled,
// the latest fit still wins, so this only overrides the old always-take-the-last
// behaviour when it would otherwise cut straight across a build-up or a drop.
// `phraseDownbeat(k)` returns the time of the k-th phrase downbeat (caller binds it to
// the deck's detected bar/phrase phase).
export function outroStart(deck, duration, phraseDownbeat) {
  const needed = deck.buffer.duration - duration - 0.75;
  const candidates = [];
  for (let k = 0; ; k += 1) {
    const time = phraseDownbeat(k);
    if (time === undefined || time > needed) break;
    candidates.push({ k, time });
  }
  if (!candidates.length) return clamp(phraseDownbeat(0) ?? 0, 0, deck.buffer.duration - 0.05);

  const data = deck.buffer.getChannelData(0);
  const { sampleRate } = deck.buffer;
  const phraseBeats = TRANSITION_BARS * 4;
  const lastK = candidates[candidates.length - 1].k;
  const searchFrom = Math.max(0, candidates.length - OUTRO_SEARCH_PHRASES);

  let best = candidates[candidates.length - 1];
  let bestScore = -Infinity;
  for (let i = searchFrom; i < candidates.length; i += 1) {
    const { k, time } = candidates[i];
    const index = deck.barPhase + 4 * deck.phrasePhase + phraseBeats * k;
    const stability = outroStability(data, sampleRate, deck.beats, index, phraseBeats);
    if (!Number.isFinite(stability)) continue;
    const score = Math.log(stability) - (lastK - k) * OUTRO_LATENESS_BIAS;
    if (score > bestScore) { bestScore = score; best = candidates[i]; }
  }
  return clamp(best.time, 0, deck.buffer.duration - 0.05);
}

// The one transition primitive. Both `out` and `in` are makeChannel() results whose
// sources are already scheduled to start at (or before) `startTime`. Levels let a
// continuous player fade out from / into each track's own solo loudness instead of
// assuming 1.0; the A/B lab passes outLevel=1, inLevel=level-matched B.
//
//  - Equal-power crossfade across the whole phrase — constant power, no mid dip.
//  - A keeps its full spectrum until the swap; B enters with lows removed and its
//    mids/highs opening over the first half so the two don't clash on top.
//  - Fast bass swap on the mid-phrase downbeat: exactly one kick is ever present,
//    so there is no muddy two-bassline overlap and no low-end dropout.
export function scheduleCrossfade({
  out, in: inc, startTime, common, transitionSeconds, outLevel = 1, inLevel = 1,
}) {
  const beatSeconds = common;

  out.gain.gain.setValueCurveAtTime(scaleCurve(FADE_OUT_CURVE, outLevel), startTime, transitionSeconds);
  inc.gain.gain.setValueCurveAtTime(scaleCurve(FADE_IN_CURVE, inLevel), startTime, transitionSeconds);

  out.mid.gain.setValueAtTime(0, startTime);
  out.high.gain.setValueAtTime(0, startTime);
  scheduleValue(inc.mid.gain, startTime, -4, 0, transitionSeconds * 0.5);
  scheduleValue(inc.high.gain, startTime, -6, 0, transitionSeconds * 0.5);

  // Bass: A owns the low end until the swap, B after it. Each owner's low shelf tracks the
  // inverse of its own fade (holdBass), and the swap itself is a 2-beat linear-dB ramp.
  const swapHalf = beatSeconds / transitionSeconds;
  const swapStart = startTime + transitionSeconds * (0.5 - swapHalf);
  const swapEnd = startTime + transitionSeconds * (0.5 + swapHalf);
  holdBass(out.low.gain, startTime, transitionSeconds, 0, 0.5 - swapHalf, (x) => Math.cos((x * Math.PI) / 2), false);
  out.low.gain.linearRampToValueAtTime(BASS_CUT_DB, swapEnd);
  inc.low.gain.setValueAtTime(BASS_CUT_DB, startTime);
  inc.low.gain.setValueAtTime(BASS_CUT_DB, swapStart);
  holdBass(inc.low.gain, startTime, transitionSeconds, 0.5 + swapHalf, 1, (x) => Math.sin((x * Math.PI) / 2), true);
}

export { clamp };
