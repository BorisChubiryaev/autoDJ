// Pure analysis layer: no DOM, no AudioContext — safe to run inside a Web Worker.
// The caller decodes and resamples the audio and passes plain Float32Arrays in.
import MusicTempo from 'music-tempo';

export const HOUSE_MIN_BPM = 112;
export const HOUSE_MAX_BPM = 136;
export const PHRASE_BARS = 16;
export const INTRO_SEARCH_PHRASES = 3;
export const ENTRY_MAX_SECONDS = 60; // B must come in from its intro, not mid-track
export const ANALYSIS_SECONDS = 75; // tempo tracking window
export const STRUCTURE_SECONDS = 150; // structure/energy window
export const TEMPO_SR = 44100; // MusicTempo's hopSize of 441 assumes 44.1 kHz
export const STRUCTURE_SR = 22050;

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function localEnergy(data, sampleRate, time, radius) {
  const start = Math.max(0, Math.floor((time - radius) * sampleRate));
  const end = Math.min(data.length, Math.ceil((time + radius) * sampleRate));
  let energy = 0;
  for (let index = start; index < end; index += 4) energy += Math.abs(data[index]);
  return energy / Math.max(1, (end - start) / 4);
}

// The tracker can lock onto off-beat hats and report ~250 BPM for 125 BPM house.
// Collapse that pulse to 1/2 (or another whole multiple) and retain the phase
// with the strongest kick energy. This is what turns pulse detection into a DJ beatgrid.
function normaliseHousePulse(mono, sampleRate, rawBeats) {
  const pulseIntervals = rawBeats.slice(1).map((beat, index) => beat - rawBeats[index])
    .filter((interval) => interval > 0.16 && interval < 0.7);
  const pulsePeriod = median(pulseIntervals);
  const possibleStrides = [1, 2, 3, 4].filter((stride) => {
    const bpm = 60 / (pulsePeriod * stride);
    return bpm >= HOUSE_MIN_BPM && bpm <= HOUSE_MAX_BPM;
  });
  if (!possibleStrides.length) throw new Error('Пульсация вне house-диапазона');
  const stride = possibleStrides.sort((a, b) => Math.abs(60 / (pulsePeriod * a) - 124) - Math.abs(60 / (pulsePeriod * b) - 124))[0];
  let trackedBeats = [];
  let strongestPhase = -Infinity;
  for (let phase = 0; phase < stride; phase += 1) {
    const candidate = rawBeats.filter((_, index) => index % stride === phase);
    const energy = candidate.reduce((sum, beat) => sum + localEnergy(mono, sampleRate, beat, 0.025), 0) / candidate.length;
    if (energy > strongestPhase) { strongestPhase = energy; trackedBeats = candidate; }
  }
  if (trackedBeats.length < 8) throw new Error('Нестабильная сетка битов');
  const { period: beatPeriod, origin: gridOrigin } = fitBeatGrid(trackedBeats);
  const expectedPeriod = pulsePeriod * stride;
  if (beatPeriod < expectedPeriod * 0.94 || beatPeriod > expectedPeriod * 1.06) throw new Error('Нестабильная сетка битов');
  return { beatPeriod, gridOrigin };
}

function fitBeatGrid(beats) {
  const count = beats.length;
  const averageIndex = (count - 1) / 2;
  const averageTime = beats.reduce((sum, beat) => sum + beat, 0) / count;
  let covariance = 0;
  let variance = 0;
  beats.forEach((beat, index) => {
    covariance += (index - averageIndex) * (beat - averageTime);
    variance += (index - averageIndex) ** 2;
  });
  const period = covariance / variance;
  return { period, origin: averageTime - period * averageIndex };
}

function createBeatGrid(origin, period, duration) {
  const first = origin - Math.ceil(origin / period) * period;
  const beats = [];
  for (let beat = first; beat <= duration + period; beat += period) if (beat >= 0) beats.push(beat);
  return beats;
}

// Which beat of the grid is beat 1 of a bar. In four-on-the-floor every beat carries
// a kick, so the kick cannot mark the downbeat — the clap/snare on beats 2 and 4 can.
// Medians rather than sums so a single loud hit can't decide the phase.
function detectBarPhase(clap, sampleRate, beats, covered) {
  // Only beats the clap render actually covers — reading past the end returns zeros,
  // which would drag the medians to zero and silently kill the detection.
  const perBeat = [];
  for (let index = 0; index < beats.length; index += 1) {
    if (beats[index] >= covered - 0.05) break;
    perBeat.push(localEnergy(clap, sampleRate, beats[index], 0.03));
  }
  if (perBeat.length < 16) return { barPhase: 0, backbeatRatio: 0, barConfident: false };
  let bestPhase = 0;
  let bestRatio = 0;
  for (let phase = 0; phase < 4; phase += 1) {
    const back = [];
    const front = [];
    perBeat.forEach((energy, index) => {
      const position = ((index - phase) % 4 + 4) % 4;
      (position === 1 || position === 3 ? back : front).push(energy);
    });
    const ratio = median(back) / Math.max(median(front), 1e-9);
    if (ratio > bestRatio) { bestRatio = ratio; bestPhase = phase; }
  }
  // A weak backbeat means the cue is unreliable; guessing wrong costs three beats
  // of alignment, so fall back to the grid's own phase instead.
  const confident = bestRatio >= 1.15;
  return { barPhase: confident ? bestPhase : 0, backbeatRatio: bestRatio, barConfident: confident };
}

// Which bar starts a 16-bar phrase. Structural changes (a drop, a new layer) land on
// phrase boundaries, so the phase whose bar edges carry the most energy novelty wins.
function detectPhrasePhase(mono, sampleRate, beats, barPhase, covered) {
  const barEnergy = [];
  for (let index = barPhase; index + 4 <= beats.length; index += 4) {
    if (beats[index + 3] >= covered - 0.2) break;
    let energy = 0;
    for (let step = 0; step < 4; step += 1) energy += localEnergy(mono, sampleRate, beats[index + step], 0.12);
    barEnergy.push(energy / 4);
  }
  const novelty = barEnergy.map((energy, index) => (index === 0 ? 0 : Math.abs(energy - barEnergy[index - 1])));
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < PHRASE_BARS; phase += 1) {
    let sum = 0;
    let count = 0;
    for (let bar = phase; bar < novelty.length; bar += PHRASE_BARS) { sum += novelty[bar]; count += 1; }
    const score = count ? sum / count : 0;
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }
  return { phrasePhase: bestPhase, phraseNovelty: bestScore };
}

export const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Camelot wheel position for each pitch class; the B ring is major, the A ring minor.
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
// Krumhansl-Schmuckler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const KEY_MARGIN_MIN = 0.08; // below this the runner-up key is essentially as likely
const CHROMA_BLOCK = 8192; // 0.37 s at 22.05 kHz — enough resolution to separate semitones
const CHROMA_LOW_HZ = 130.81; // C3; below this the bin spacing gets too tight to resolve
const CHROMA_OCTAVES = 3;

// Goertzel: the power at a single frequency, far cheaper than a full FFT when only
// three octaves of semitone centres are needed.
function goertzelPower(windowed, length, freq, sampleRate) {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i += 1) {
    const s0 = windowed[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function computeChroma(mono, sampleRate, covered) {
  const semitones = CHROMA_OCTAVES * 12;
  const freqs = new Float64Array(semitones);
  for (let n = 0; n < semitones; n += 1) freqs[n] = CHROMA_LOW_HZ * 2 ** (n / 12);
  const hann = new Float64Array(CHROMA_BLOCK);
  for (let i = 0; i < CHROMA_BLOCK; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (CHROMA_BLOCK - 1));

  const chroma = new Float64Array(12);
  const block = new Float64Array(12);
  const windowed = new Float64Array(CHROMA_BLOCK);
  const limit = Math.min(mono.length, Math.floor(covered * sampleRate));
  for (let start = 0; start + CHROMA_BLOCK <= limit; start += CHROMA_BLOCK) {
    let energy = 0;
    for (let i = 0; i < CHROMA_BLOCK; i += 1) {
      const value = mono[start + i] * hann[i];
      windowed[i] = value;
      energy += value * value;
    }
    if (energy < 1e-6) continue; // skip near-silence so it can't tilt the profile
    block.fill(0);
    for (let n = 0; n < semitones; n += 1) {
      // Log compression keeps one screaming lead from outweighing the harmony.
      block[n % 12] += Math.log1p(Math.sqrt(goertzelPower(windowed, CHROMA_BLOCK, freqs[n], sampleRate)));
    }
    // Give every block the same vote, so loud drops don't decide the key alone.
    const blockTotal = block.reduce((sum, value) => sum + value, 0);
    if (blockTotal <= 0) continue;
    for (let i = 0; i < 12; i += 1) chroma[i] += block[i] / blockTotal;
  }
  const total = chroma.reduce((sum, value) => sum + value, 0) || 1;
  return Array.from(chroma, (value) => value / total);
}

function correlate(a, b) {
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let devA = 0;
  let devB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    devA += da * da;
    devB += db * db;
  }
  return num / Math.max(Math.sqrt(devA * devB), 1e-12);
}

// Rotates both key profiles across all twelve tonics and keeps the best match.
// The margin over the runner-up is the confidence we surface.
function detectKey(chroma) {
  const scored = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const rotated = chroma.map((_, i) => chroma[(i + tonic) % 12]);
    scored.push({ tonic, mode: 'major', score: correlate(rotated, MAJOR_PROFILE) });
    scored.push({ tonic, mode: 'minor', score: correlate(rotated, MINOR_PROFILE) });
  }
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  const camelotNumber = best.mode === 'major' ? MAJOR_CAMELOT[best.tonic] : MINOR_CAMELOT[best.tonic];
  const margin = best.score - scored[1].score;
  // Chroma from a percussive dance mix separates the tonic well but the major/minor
  // decision is often a coin flip, so a thin margin is reported rather than hidden.
  const runnerUp = scored[1];
  return {
    key: `${KEY_NAMES[best.tonic]}${best.mode === 'minor' ? 'm' : ''}`,
    keyTonic: best.tonic,
    keyMode: best.mode,
    camelot: `${camelotNumber}${best.mode === 'minor' ? 'A' : 'B'}`,
    camelotNumber,
    camelotLetter: best.mode === 'minor' ? 'A' : 'B',
    keyScore: best.score,
    keyMargin: margin,
    keyConfident: margin >= KEY_MARGIN_MIN,
    keyAlternative: `${KEY_NAMES[runnerUp.tonic]}${runnerUp.mode === 'minor' ? 'm' : ''}`,
  };
}

function findFirstAudible(data, sampleRate) {
  const frame = 2048;
  const maxFrames = Math.min(Math.floor(data.length / frame), Math.ceil(sampleRate * 45 / frame));
  const energies = [];
  for (let part = 0; part < maxFrames; part += 1) {
    let energy = 0;
    const start = part * frame;
    for (let i = start; i < start + frame; i += 8) energy += Math.abs(data[i]);
    energies.push(energy / (frame / 8));
  }
  const maxEnergy = Math.max(...energies, 0.001);
  const threshold = Math.max(0.006, maxEnergy * 0.1);
  const index = energies.findIndex((energy) => energy >= threshold);
  return Math.max(0, (index < 0 ? 0 : index) * frame / sampleRate);
}

function percussivePhraseScore(data, sampleRate, beats, start, count, period) {
  let onBeat = 0;
  let offBeat = 0;
  for (let i = 0; i < count && start + i < beats.length; i += 1) {
    onBeat += localEnergy(data, sampleRate, beats[start + i], 0.028);
    offBeat += localEnergy(data, sampleRate, beats[start + i] + period * 0.36, 0.05);
  }
  return onBeat / Math.max(offBeat, 0.00001);
}

// Beat index of the k-th real phrase downbeat, i.e. anchored on the detected bar and
// phrase phase rather than on beat zero of an arbitrarily-aligned grid.
export function phraseDownbeatIndex(barPhase, phrasePhase, k) {
  return barPhase + 4 * phrasePhase + PHRASE_BARS * 4 * k;
}

// Picks the opening phrase whose kick energy most outweighs its off-beat energy,
// evaluated only at real phrase downbeats. A catalog-grade structure model will
// replace this conservative intro policy.
function chooseEntryPoint({ mono, sampleRate, beats, period, barPhase, phrasePhase, covered }) {
  const firstAudible = findFirstAudible(mono, sampleRate);
  const phraseBeats = PHRASE_BARS * 4;
  let first = 0;
  while (beats[phraseDownbeatIndex(barPhase, phrasePhase, first)] !== undefined
    && beats[phraseDownbeatIndex(barPhase, phrasePhase, first)] < firstAudible) first += 1;

  let bestIndex = phraseDownbeatIndex(barPhase, phrasePhase, first);
  let bestScore = -Infinity;
  for (let k = first; k < first + INTRO_SEARCH_PHRASES; k += 1) {
    const index = phraseDownbeatIndex(barPhase, phrasePhase, k);
    if (index + phraseBeats >= beats.length) break;
    if (beats[index] > ENTRY_MAX_SECONDS) break;
    if (beats[index + phraseBeats] >= covered) break;
    // Later phrases must be clearly more percussive to be worth skipping intro time.
    const score = Math.log(percussivePhraseScore(mono, sampleRate, beats, index, phraseBeats, period))
      - (k - first) * 0.45;
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  }
  return beats[bestIndex] ?? beats[0] ?? 0;
}

function fallbackAnalysis({ mono, structureSr, duration }) {
  const bpm = 124;
  const beatPeriod = 60 / bpm;
  const beats = createBeatGrid(0, beatPeriod, duration);
  const covered = mono.length / structureSr;
  return {
    bpm, beatPeriod, gridOrigin: 0, beats, barPhase: 0, phrasePhase: 0,
    backbeatRatio: 0, barConfident: false, phraseNovelty: 0, fallback: true,
    entryPoint: chooseEntryPoint({
      mono, sampleRate: structureSr, beats, period: beatPeriod, barPhase: 0, phrasePhase: 0, covered,
    }),
    ...detectKey(computeChroma(mono, structureSr, covered)),
  };
}

// Distance around the 12-spoke Camelot wheel; 0 means the same spoke.
function wheelDistance(a, b) {
  const raw = Math.abs(a - b) % 12;
  return Math.min(raw, 12 - raw);
}

// Harmonic verdict for a pair. Tempo matching resamples both decks, which detunes
// them relative to each other by 12*log2(rateA/rateB) semitones — a pair that looks
// compatible on the wheel still beats against itself if that shift is large.
export function harmonicMatch(a, b, rateA = 1, rateB = 1) {
  const detune = 12 * Math.log2(rateA / rateB);
  const steps = wheelDistance(a.camelotNumber, b.camelotNumber);
  const sameLetter = a.camelotLetter === b.camelotLetter;
  let level;
  if (steps === 0 && sameLetter) level = 'perfect';
  else if (steps === 0) level = 'relative'; // relative major/minor share a spoke
  else if (steps === 1 && sameLetter) level = 'neighbour';
  else level = 'clash';
  // A clash call is only as trustworthy as the two key estimates behind it.
  const certain = a.keyConfident && b.keyConfident;
  if (!certain) level = 'unknown';
  const detuneHeavy = Math.abs(detune) > 0.4;
  return {
    detune,
    steps,
    level,
    certain,
    compatible: level !== 'clash',
    // Above roughly a third of a semitone the resampling detune is audible against
    // a sustained pad or bassline, so a wheel match no longer guarantees a clean blend.
    detuneHeavy,
  };
}

export function analyseTrack({ tempoSignal, mono, clap, structureSr, duration }) {
  try {
    const tracker = new MusicTempo(tempoSignal, {
      timeStep: 0.01,
      bufferSize: 2048,
      hopSize: 441,
      minBeatInterval: 60 / HOUSE_MAX_BPM,
      maxBeatInterval: 60 / HOUSE_MIN_BPM,
      peakThreshold: 0.28,
      toleranceWndInner: 0.025,
      thresholdBT: 0.025,
    });
    const rawBeats = tracker.beats.filter((beat) => Number.isFinite(beat) && beat >= 0);
    if (rawBeats.length < 8) throw new Error('Недостаточно ритмических событий');
    const { beatPeriod, gridOrigin } = normaliseHousePulse(mono, structureSr, rawBeats);
    const bpm = 60 / beatPeriod;
    if (bpm < HOUSE_MIN_BPM || bpm > HOUSE_MAX_BPM || !Number.isFinite(bpm)) throw new Error('Темп вне house-диапазона');
    const beats = createBeatGrid(gridOrigin, beatPeriod, duration);
    // How much of the track the structure renders actually cover; every energy
    // measurement below must stay inside it or it reads silence past the end.
    const covered = Math.min(mono.length / structureSr, clap.length / structureSr);
    const { barPhase, backbeatRatio, barConfident } = detectBarPhase(clap, structureSr, beats, covered);
    const { phrasePhase, phraseNovelty } = detectPhrasePhase(mono, structureSr, beats, barPhase, covered);
    const entryPoint = chooseEntryPoint({
      mono, sampleRate: structureSr, beats, period: beatPeriod, barPhase, phrasePhase, covered,
    });
    const key = detectKey(computeChroma(mono, structureSr, covered));
    return {
      bpm, beatPeriod, gridOrigin, beats, barPhase, phrasePhase,
      backbeatRatio, barConfident, phraseNovelty, entryPoint, fallback: false, ...key,
    };
  } catch (error) {
    return { ...fallbackAnalysis({ mono, structureSr, duration }), error: error.message };
  }
}
