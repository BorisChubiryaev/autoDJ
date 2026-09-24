// Dev-only: renders a real transition through the shipped mixer (src/mixer.js) into an
// OfflineAudioContext and measures it, so mix quality is confirmed by numbers rather
// than by ear in a headless tab. Checks: no clipping past the limiter, and an
// equal-power crossfade with no systematic loudness hole in the middle of the blend.
import { analyzeBuffer } from '/src/analyze-audio.js';
import {
  TRANSITION_BARS, tempoPlan, makeChannel, makeMaster, outroStart, scheduleCrossfade, clamp,
} from '/src/mixer.js';

async function decode(url) {
  const ac = new AudioContext();
  const buffer = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
  await ac.close();
  return buffer;
}
const phraseDownbeat = (d, k) => d.beats[d.barPhase + 4 * d.phrasePhase + TRANSITION_BARS * 4 * k];

// mode 'ab'  → geometric-mean tempo, outFrom 1 / inTo matchB  (the A/B lab path)
// mode 'set' → both decks pinned to `commonPeriod`, level-matched to a reference RMS
//              (the continuous player path)
export async function renderTransition(urlA, urlB, { mode = 'ab', commonPeriod = null, refRms = null } = {}) {
  const [ba, bb] = await Promise.all([decode(urlA), decode(urlB)]);
  const [a, b] = await Promise.all([analyzeBuffer(ba), analyzeBuffer(bb)]);

  let rateA; let rateB; let P;
  if (mode === 'set') {
    P = commonPeriod ?? Math.sqrt(a.beatPeriod * b.beatPeriod);
    rateA = clamp(a.beatPeriod / P, 0.94, 1.06);
    rateB = clamp(b.beatPeriod / P, 0.94, 1.06);
  } else {
    const plan = tempoPlan(a.beatPeriod, b.beatPeriod);
    ({ rateA, rateB } = plan); P = plan.common;
  }
  const L = TRANSITION_BARS * 4 * P;
  const aOffset = outroStart(a, TRANSITION_BARS * 4 * a.beatPeriod, (k) => phraseDownbeat(a, k));
  const bOffset = b.entryPoint;
  const outLevel = mode === 'set' ? clamp((refRms ?? a.rms) / a.rms, 0.5, 2) : 1;
  const inLevel = clamp((refRms ?? a.rms) / b.rms, 0.5, 2);

  const sr = 44100;
  const octx = new OfflineAudioContext(2, Math.ceil((L + 1.0) * sr), sr);
  const master = makeMaster(octx);
  const ca = makeChannel(octx, a.buffer, master);
  const cb = makeChannel(octx, b.buffer, master);
  const t0 = 0.05;
  ca.source.playbackRate.value = rateA;
  cb.source.playbackRate.value = rateB;
  ca.source.start(t0, aOffset);
  cb.source.start(t0, bOffset);
  scheduleCrossfade({ out: ca, in: cb, startTime: t0, common: P, transitionSeconds: L, outLevel, inLevel });

  const out = await octx.startRendering();
  const c0 = out.getChannelData(0);
  const c1 = out.getChannelData(1);
  let peak = 0; let clipped = 0;
  for (let i = 0; i < c0.length; i += 1) {
    const m = Math.max(Math.abs(c0[i]), Math.abs(c1[i]));
    if (m > peak) peak = m;
    if (m > 0.999) clipped += 1;
  }
  const wins = 12;
  const start = Math.floor(t0 * sr);
  const span = (L * sr) / wins;
  const env = [];
  for (let w = 0; w < wins; w += 1) {
    let s = 0; let c = 0;
    for (let i = Math.floor(start + w * span); i < Math.floor(start + (w + 1) * span); i += 1) {
      const v = (c0[i] + c1[i]) / 2; s += v * v; c += 1;
    }
    env.push(Math.sqrt(s / Math.max(1, c)));
  }
  const mid = env.slice(3, 9);
  const edges = [env[1], env[2], env[9], env[10]];
  const midAvg = mid.reduce((x, y) => x + y, 0) / mid.length;
  const edgeAvg = edges.reduce((x, y) => x + y, 0) / edges.length;
  return {
    mode,
    pair: `${urlA.split('/').pop().slice(0, 20)} → ${urlB.split('/').pop().slice(0, 20)}`,
    bpm: +(60 / P).toFixed(2),
    rateA: +rateA.toFixed(4), rateB: +rateB.toFixed(4),
    aOffset: +aOffset.toFixed(2), bOffset: +bOffset.toFixed(2),
    peak: +peak.toFixed(4),
    clipped,
    midDip: +(midAvg / edgeAvg).toFixed(3), // ~1 = flat blend; <<1 = hole in the middle
    env: env.map((e) => +e.toFixed(3)),
  };
}

// Renders the continuous-player path with its real boundaries: the outgoing track
// plays solo (flat EQ, solo level) for a few bars, then the crossfade begins, then the
// incoming track continues solo. Catches discontinuities the crossfade-only render can't:
// a click at solo→blend or blend→solo (max sample step), and the envelope through both
// boundaries.
export async function renderContinuous(urlA, urlB, { commonPeriod = null, refRms = null, soloBars = 4 } = {}) {
  const [ba, bb] = await Promise.all([decode(urlA), decode(urlB)]);
  const [a, b] = await Promise.all([analyzeBuffer(ba), analyzeBuffer(bb)]);
  const P = commonPeriod ?? Math.sqrt(a.beatPeriod * b.beatPeriod);
  const rateA = clamp(a.beatPeriod / P, 0.94, 1.06);
  const rateB = clamp(b.beatPeriod / P, 0.94, 1.06);
  const L = TRANSITION_BARS * 4 * P;
  const outOffset = outroStart(a, TRANSITION_BARS * 4 * a.beatPeriod, (k) => phraseDownbeat(a, k));
  const aStartOffset = Math.max(0, outOffset - soloBars * 4 * a.beatPeriod);
  const bOffset = b.entryPoint;
  const outLevel = clamp((refRms ?? a.rms) / a.rms, 0.5, 2);
  const inLevel = clamp((refRms ?? a.rms) / b.rms, 0.5, 2);

  const sr = 44100;
  const leadWall = (outOffset - aStartOffset) / rateA;
  const octx = new OfflineAudioContext(2, Math.ceil((leadWall + L + 1.0) * sr), sr);
  const master = makeMaster(octx);
  const ca = makeChannel(octx, a.buffer, master);
  const cb = makeChannel(octx, b.buffer, master);
  const t0 = 0.02;
  ca.source.playbackRate.value = rateA;
  cb.source.playbackRate.value = rateB;
  ca.gain.gain.value = outLevel; // outgoing plays solo at its level, flat EQ
  ca.source.start(t0, aStartOffset);
  const blendStart = t0 + leadWall;
  cb.source.start(blendStart, bOffset);
  scheduleCrossfade({ out: ca, in: cb, startTime: blendStart, common: P, transitionSeconds: L, outLevel, inLevel });
  ca.source.stop(blendStart + L + 0.2);

  const out = await octx.startRendering();
  const c0 = out.getChannelData(0);
  const c1 = out.getChannelData(1);
  let peak = 0; let clipped = 0; let maxStep = 0; let prev = 0;
  for (let i = 0; i < c0.length; i += 1) {
    const m = Math.max(Math.abs(c0[i]), Math.abs(c1[i]));
    if (m > peak) peak = m;
    if (m > 0.999) clipped += 1;
    const mono = (c0[i] + c1[i]) / 2;
    const step = Math.abs(mono - prev);
    if (step > maxStep) maxStep = step;
    prev = mono;
  }
  // Step right at the solo→blend boundary (where the incoming source switches on).
  const stepAt = (t) => {
    const i0 = Math.floor(t * sr); let s = 0;
    for (let i = i0 - 3; i <= i0 + 3; i += 1) {
      s = Math.max(s, Math.abs((c0[i] + c1[i]) / 2 - (c0[i - 1] + c1[i - 1]) / 2));
    }
    return +s.toFixed(4);
  };
  return {
    pair: `${urlA.split('/').pop().slice(0, 18)} → ${urlB.split('/').pop().slice(0, 18)}`,
    leadWall: +leadWall.toFixed(2), blendLen: +L.toFixed(1),
    peak: +peak.toFixed(4), clipped,
    maxStep: +maxStep.toFixed(4),
    stepAtBlendStart: stepAt(blendStart),
    stepAtBlendEnd: stepAt(blendStart + L),
  };
}
