// Shared mixing engine — the DOM-free transition core used by both the A/B lab
// (main.js) and the continuous Zvuk-style player (player.js). Keeping it in one
// place is deliberate: the earlier phase regressed when tuned constants drifted
// between copies, so every deck EQ curve, the equal-power crossfade, the bass swap
// and the tempo lock live here once and are verified once (lab/, offline render).

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

// A master gain feeding a limiter into the destination. The two decks overlap at
// full level mid-transition, so the limiter catches peaks above ~-1.5 dBFS instead
// of letting the sum clip.
export function makeMaster(context, level = 0.9) {
  const master = context.createGain();
  master.gain.value = level;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-1.5, context.currentTime);
  limiter.knee.setValueAtTime(0, context.currentTime);
  limiter.ratio.setValueAtTime(20, context.currentTime);
  limiter.attack.setValueAtTime(0.003, context.currentTime);
  limiter.release.setValueAtTime(0.25, context.currentTime);
  master.connect(limiter).connect(context.destination);
  return master;
}

// Latest real phrase downbeat that still leaves room for the whole transition, so
// the outgoing track's outro starts on a musical boundary instead of a bar counted
// off the grid origin. `phraseDownbeat(k)` returns the time of the k-th phrase
// downbeat (caller binds it to the deck's detected bar/phrase phase).
export function outroStart(deck, duration, phraseDownbeat) {
  const needed = deck.buffer.duration - duration - 0.75;
  let best = null;
  for (let k = 0; ; k += 1) {
    const time = phraseDownbeat(k);
    if (time === undefined || time > needed) break;
    best = time;
  }
  if (best === null) best = phraseDownbeat(0) ?? 0;
  return clamp(best, 0, deck.buffer.duration - 0.05);
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

  out.low.gain.setValueAtTime(0, startTime);
  out.mid.gain.setValueAtTime(0, startTime);
  out.high.gain.setValueAtTime(0, startTime);
  inc.low.gain.setValueAtTime(BASS_CUT_DB, startTime);
  scheduleValue(inc.mid.gain, startTime, -4, 0, transitionSeconds * 0.5);
  scheduleValue(inc.high.gain, startTime, -6, 0, transitionSeconds * 0.5);

  const swapDur = 2 * beatSeconds;
  const swapStart = startTime + transitionSeconds * 0.5 - swapDur / 2;
  scheduleValue(out.low.gain, swapStart, 0, BASS_CUT_DB, swapDur);
  scheduleValue(inc.low.gain, swapStart, BASS_CUT_DB, 0, swapDur);
}

export { clamp };
