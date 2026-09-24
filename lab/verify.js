// Dev-only: verifies the shipped analysis module puts both mix points on real
// bar/phrase downbeats, and that the two decks meet bar-aligned.
import {
  analyseTrack, phraseDownbeatIndex, PHRASE_BARS,
  ANALYSIS_SECONDS, STRUCTURE_SECONDS, TEMPO_SR, STRUCTURE_SR,
} from '/src/analysis.js';

const TRANSITION_BARS = 16;
const MAX_TEMPO_STRETCH = 0.06;

async function renderMono(buffer, { sampleRate, seconds, band }) {
  const length = Math.min(buffer.duration, seconds);
  const offline = new OfflineAudioContext(1, Math.ceil(length * sampleRate), sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  let node = source;
  if (band === 'clap') {
    const hp = offline.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1500; hp.Q.value = 0.7;
    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5000; lp.Q.value = 0.7;
    node = node.connect(hp).connect(lp);
  }
  node.connect(offline.destination);
  source.start(0, 0, length);
  return (await offline.startRendering()).getChannelData(0);
}

export async function analyse(url) {
  const ctx = new AudioContext();
  const buffer = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const [tempoSignal, mono, clap] = await Promise.all([
    renderMono(buffer, { sampleRate: TEMPO_SR, seconds: ANALYSIS_SECONDS }),
    renderMono(buffer, { sampleRate: STRUCTURE_SR, seconds: STRUCTURE_SECONDS }),
    renderMono(buffer, { sampleRate: STRUCTURE_SR, seconds: STRUCTURE_SECONDS, band: 'clap' }),
  ]);
  const result = analyseTrack({
    tempoSignal, mono, clap, structureSr: STRUCTURE_SR, duration: buffer.duration,
  });
  ctx.close();
  return { ...result, duration: buffer.duration, name: url.split('/').pop().slice(0, 26) };
}

function outroStart(deck, duration) {
  const needed = deck.duration - duration - 0.75;
  let best = null;
  for (let k = 0; ; k += 1) {
    const time = deck.beats[phraseDownbeatIndex(deck.barPhase, deck.phrasePhase, k)];
    if (time === undefined || time > needed) break;
    best = time;
  }
  if (best === null) best = deck.beats[phraseDownbeatIndex(deck.barPhase, deck.phrasePhase, 0)] ?? 0;
  return best;
}

// Is `time` exactly on one of this deck's real phrase downbeats?
function phraseOffsetBeats(deck, time) {
  let nearest = 0;
  let bestDist = Infinity;
  deck.beats.forEach((beat, index) => {
    const dist = Math.abs(beat - time);
    if (dist < bestDist) { bestDist = dist; nearest = index; }
  });
  const phraseBeats = PHRASE_BARS * 4;
  const anchor = deck.barPhase + 4 * deck.phrasePhase;
  return {
    beatIndex: nearest,
    snapErrMs: +(bestDist * 1000).toFixed(1),
    barOffset: ((nearest - deck.barPhase) % 4 + 4) % 4,
    phraseOffsetBars: Math.floor((((nearest - anchor) % phraseBeats + phraseBeats) % phraseBeats) / 4),
  };
}

export function planPair(a, b) {
  const common = Math.sqrt(a.beatPeriod * b.beatPeriod);
  const rateA = a.beatPeriod / common;
  const rateB = b.beatPeriod / common;
  const aOutroLen = TRANSITION_BARS * 4 * a.beatPeriod;
  const aOffset = outroStart(a, aOutroLen);
  const bOffset = b.entryPoint;
  return {
    pair: `${a.name} → ${b.name}`,
    commonBpm: +(60 / common).toFixed(2),
    rateA: +rateA.toFixed(4), rateB: +rateB.toFixed(4),
    feasible: Math.abs(rateA - 1) <= MAX_TEMPO_STRETCH + 1e-6 && Math.abs(rateB - 1) <= MAX_TEMPO_STRETCH + 1e-6,
    aOffset: +aOffset.toFixed(2),
    bOffset: +bOffset.toFixed(2),
    aTailLeft: +(a.duration - aOffset - TRANSITION_BARS * 4 * a.beatPeriod).toFixed(1),
    aPoint: phraseOffsetBeats(a, aOffset),
    bPoint: phraseOffsetBeats(b, bOffset),
  };
}
