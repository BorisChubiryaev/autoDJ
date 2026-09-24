// Dev-only diagnostic harness. Not part of the app bundle.
// Measures beatgrid, true bar/phrase phase and mix-point alignment for a set of tracks.
import MusicTempo from 'music-tempo';

const HOUSE_MIN_BPM = 112;
const HOUSE_MAX_BPM = 136;
const ANALYSIS_SECONDS = 75;
const SR = 44100;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

// Renders the whole track to mono at SR, optionally through a band filter,
// so every energy measurement below runs on the same timebase.
async function renderBand(buffer, band) {
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * SR), SR);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  let node = src;
  if (band === 'low') {
    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 150; lp.Q.value = 0.7;
    node = node.connect(lp);
  } else if (band === 'clap') {
    const hp = offline.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1500; hp.Q.value = 0.7;
    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5000; lp.Q.value = 0.7;
    node = node.connect(hp).connect(lp);
  }
  node.connect(offline.destination);
  src.start(0);
  return (await offline.startRendering()).getChannelData(0);
}

function localEnergy(data, sampleRate, time, radius) {
  const start = Math.max(0, Math.floor((time - radius) * sampleRate));
  const end = Math.min(data.length, Math.ceil((time + radius) * sampleRate));
  let energy = 0;
  for (let i = start; i < end; i += 4) energy += Math.abs(data[i]);
  return energy / Math.max(1, (end - start) / 4);
}

function fitBeatGrid(beats) {
  const count = beats.length;
  const ai = (count - 1) / 2;
  const at = beats.reduce((s, b) => s + b, 0) / count;
  let cov = 0, varr = 0;
  beats.forEach((b, i) => { cov += (i - ai) * (b - at); varr += (i - ai) ** 2; });
  const period = cov / varr;
  return { period, origin: at - period * ai };
}

function createBeatGrid(origin, period, duration) {
  const first = origin - Math.ceil(origin / period) * period;
  const beats = [];
  for (let b = first; b <= duration + period; b += period) if (b >= 0) beats.push(b);
  return beats;
}

function normaliseHousePulse(mono, rawBeats) {
  const intervals = rawBeats.slice(1).map((b, i) => b - rawBeats[i])
    .filter((x) => x > 0.16 && x < 0.7);
  const pulsePeriod = median(intervals);
  const strides = [1, 2, 3, 4].filter((s) => {
    const bpm = 60 / (pulsePeriod * s);
    return bpm >= HOUSE_MIN_BPM && bpm <= HOUSE_MAX_BPM;
  });
  if (!strides.length) throw new Error('pulse out of range');
  const stride = strides.sort((a, b) =>
    Math.abs(60 / (pulsePeriod * a) - 124) - Math.abs(60 / (pulsePeriod * b) - 124))[0];
  let tracked = [], best = -Infinity;
  for (let phase = 0; phase < stride; phase += 1) {
    const cand = rawBeats.filter((_, i) => i % stride === phase);
    const e = cand.reduce((s, b) => s + localEnergy(mono, SR, b, 0.025), 0) / cand.length;
    if (e > best) { best = e; tracked = cand; }
  }
  const { period, origin } = fitBeatGrid(tracked);
  return { beatPeriod: period, gridOrigin: origin };
}

// True bar phase: in 4-on-the-floor every beat has a kick, so the kick cannot
// mark beat 1. The clap/snare on beats 2 and 4 can — find the phase that puts
// the most clap-band energy on the backbeats.
function detectBarPhase(clap, beats) {
  let bestPhase = 0, bestScore = -Infinity;
  for (let phase = 0; phase < 4; phase += 1) {
    let back = 0, front = 0, n = 0;
    for (let i = 0; i < beats.length; i += 1) {
      const pos = ((i - phase) % 4 + 4) % 4;
      const e = localEnergy(clap, SR, beats[i], 0.03);
      if (pos === 1 || pos === 3) back += e; else front += e;
      n += 1;
    }
    const score = back / Math.max(front, 1e-9);
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }
  return { barPhase: bestPhase, backbeatRatio: bestScore };
}

// True phrase phase: structural changes (drop, new layer) land on phrase starts,
// so the phase whose bar boundaries carry the most energy novelty is the phrase grid.
function detectPhrasePhase(mono, beats, barPhase, phraseBars = 16) {
  const barEnergy = [];
  for (let i = barPhase; i + 4 <= beats.length; i += 4) {
    let e = 0;
    for (let k = 0; k < 4; k += 1) e += localEnergy(mono, SR, beats[i + k], 0.12);
    barEnergy.push(e / 4);
  }
  const novelty = barEnergy.map((e, i) => (i === 0 ? 0 : Math.abs(e - barEnergy[i - 1])));
  let bestPhase = 0, bestScore = -Infinity;
  for (let phase = 0; phase < phraseBars; phase += 1) {
    let sum = 0, n = 0;
    for (let b = phase; b < novelty.length; b += phraseBars) { sum += novelty[b]; n += 1; }
    const score = n ? sum / n : 0;
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }
  return { phrasePhase: bestPhase, phraseNovelty: bestScore };
}

function findFirstAudible(data, sampleRate) {
  const frame = 2048;
  const maxFrames = Math.min(Math.floor(data.length / frame), Math.ceil(sampleRate * 45 / frame));
  const energies = [];
  for (let p = 0; p < maxFrames; p += 1) {
    let e = 0;
    const start = p * frame;
    for (let i = start; i < start + frame; i += 8) e += Math.abs(data[i]);
    energies.push(e / (frame / 8));
  }
  const maxE = Math.max(...energies, 0.001);
  const threshold = Math.max(0.006, maxE * 0.1);
  const idx = energies.findIndex((e) => e >= threshold);
  return Math.max(0, (idx < 0 ? 0 : idx) * frame / sampleRate);
}

function percussivePhraseScore(data, beats, start, count, period) {
  let on = 0, off = 0;
  for (let i = 0; i < count && start + i < beats.length; i += 1) {
    on += localEnergy(data, SR, beats[start + i], 0.028);
    off += localEnergy(data, SR, beats[start + i] + period * 0.36, 0.05);
  }
  return on / Math.max(off, 1e-5);
}

// Current shipped logic: steps a whole 16-bar phrase at a time, anchored on an
// arbitrary beat index rather than a detected phrase boundary.
function entryNew(mono, beats, period) {
  const firstAudible = findFirstAudible(mono, SR);
  const firstBeatIndex = Math.max(0, beats.findIndex((b) => b >= firstAudible));
  const phraseBeats = 16 * 4;
  const firstPhrase = Math.ceil(firstBeatIndex / phraseBeats) * phraseBeats;
  const maxIndex = Math.min(beats.length - phraseBeats - 1, firstPhrase + phraseBeats * 3);
  let bestIndex = firstPhrase, bestScore = -Infinity, candidates = 0;
  for (let i = firstPhrase; i <= maxIndex; i += phraseBeats) {
    candidates += 1;
    const away = (i - firstPhrase) / phraseBeats;
    const score = Math.log(percussivePhraseScore(mono, beats, i, phraseBeats, period)) - away * 0.35;
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  return { beatIndex: bestIndex, time: beats[bestIndex] ?? 0, candidates };
}

// Previous logic: bar-resolution search over 12 bars.
function entryOld(mono, beats, period) {
  const firstAudible = findFirstAudible(mono, SR);
  const firstBeatIndex = Math.max(0, beats.findIndex((b) => b >= firstAudible));
  const firstBar = Math.ceil(firstBeatIndex / 4) * 4;
  const phraseBeats = 16 * 4;
  const maxIndex = Math.min(beats.length - phraseBeats - 1, firstBar + 4 * 12);
  let bestIndex = firstBar, bestScore = -Infinity, candidates = 0;
  for (let i = firstBar; i <= maxIndex; i += 4) {
    candidates += 1;
    const away = (i - firstBar) / 4;
    const score = Math.log(percussivePhraseScore(mono, beats, i, phraseBeats, period)) - away * 0.22;
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  return { beatIndex: bestIndex, time: beats[bestIndex] ?? 0, candidates };
}

export async function analyzeTrack(url) {
  const ctx = new AudioContext();
  const raw = await (await fetch(url)).arrayBuffer();
  const buffer = await ctx.decodeAudioData(raw);
  const mono = await renderBand(buffer, 'full');
  const clap = await renderBand(buffer, 'clap');

  const tempoSignal = mono.slice(0, Math.floor(Math.min(buffer.duration, ANALYSIS_SECONDS) * SR));
  const tracker = new MusicTempo(tempoSignal, {
    timeStep: 0.01, bufferSize: 2048, hopSize: 441,
    minBeatInterval: 60 / HOUSE_MAX_BPM, maxBeatInterval: 60 / HOUSE_MIN_BPM,
    peakThreshold: 0.28, toleranceWndInner: 0.025, thresholdBT: 0.025,
  });
  const rawBeats = tracker.beats.filter((b) => Number.isFinite(b) && b >= 0);
  const { beatPeriod, gridOrigin } = normaliseHousePulse(mono, rawBeats);
  const beats = createBeatGrid(gridOrigin, beatPeriod, buffer.duration);

  const { barPhase, backbeatRatio } = detectBarPhase(clap, beats);
  const { phrasePhase, phraseNovelty } = detectPhrasePhase(mono, beats, barPhase);
  const eNew = entryNew(mono, beats, beatPeriod);
  const eOld = entryOld(mono, beats, beatPeriod);

  // How far the shipped entry point sits from a true bar / phrase downbeat.
  const barErrBeats = ((eNew.beatIndex - barPhase) % 4 + 4) % 4;
  const barIndexOfEntry = Math.floor((eNew.beatIndex - barPhase) / 4);
  const phraseErrBars = ((barIndexOfEntry - phrasePhase) % 16 + 16) % 16;

  ctx.close();
  return {
    name: url.split('/').pop().replace('.mp3', '').slice(0, 34),
    bpm: +(60 / beatPeriod).toFixed(2),
    dur: +buffer.duration.toFixed(1),
    gridOrigin: +gridOrigin.toFixed(3),
    barPhase, backbeatRatio: +backbeatRatio.toFixed(3),
    phrasePhase, phraseNovelty: +phraseNovelty.toFixed(4),
    entryNewT: +eNew.time.toFixed(2), entryNewIdx: eNew.beatIndex, candNew: eNew.candidates,
    entryOldT: +eOld.time.toFixed(2), entryOldIdx: eOld.beatIndex, candOld: eOld.candidates,
    barErrBeats, phraseErrBars,
  };
}
