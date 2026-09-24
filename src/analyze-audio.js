// Shared analysis entry point: decode → resample on the main thread → run the heavy
// beatgrid/structure/key DSP in a Web Worker. Both the A/B lab and the Zvuk-style
// player call analyzeBuffer(), so there is one place that drives src/analysis.js.
import {
  ANALYSIS_SECONDS, STRUCTURE_SECONDS, TEMPO_SR, STRUCTURE_SR,
} from './analysis.js';
import AnalysisWorker from './analysis.worker.js?worker';

// Renders one mono take of the track: either full band, or the 1.5–5 kHz clap band
// used to find the downbeat. Resampling here keeps the worker payload small.
async function renderMono(buffer, { sampleRate, seconds, band }) {
  const length = Math.min(buffer.duration, seconds);
  const offline = new OfflineAudioContext(1, Math.ceil(length * sampleRate), sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  let node = source;
  if (band === 'clap') {
    const highpass = offline.createBiquadFilter();
    highpass.type = 'highpass'; highpass.frequency.value = 1500; highpass.Q.value = 0.7;
    const lowpass = offline.createBiquadFilter();
    lowpass.type = 'lowpass'; lowpass.frequency.value = 5000; lowpass.Q.value = 0.7;
    node = node.connect(highpass).connect(lowpass);
  }
  node.connect(offline.destination);
  source.start(0, 0, length);
  return (await offline.startRendering()).getChannelData(0);
}

// Integrated RMS of the track, used to level-match decks before the crossfade so an
// incoming track doesn't jump up or drop in perceived loudness.
export function computeRms(buffer) {
  const data = buffer.getChannelData(0);
  const stride = 16;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += stride) { sum += data[i] * data[i]; count += 1; }
  return Math.sqrt(sum / Math.max(1, count)) || 0.0001;
}

let analysisWorker = null;
let analysisSeq = 0;
const pendingAnalyses = new Map();

function getWorker() {
  if (analysisWorker) return analysisWorker;
  analysisWorker = new AnalysisWorker();
  analysisWorker.onmessage = ({ data }) => {
    const pending = pendingAnalyses.get(data.id);
    if (!pending) return;
    pendingAnalyses.delete(data.id);
    if (data.ok) pending.resolve(data.result);
    else pending.reject(new Error(data.error));
  };
  analysisWorker.onerror = (event) => {
    pendingAnalyses.forEach(({ reject }) => reject(new Error(event.message || 'Analysis worker failed')));
    pendingAnalyses.clear();
  };
  return analysisWorker;
}

function analyseInWorker(payload, transfer) {
  const id = (analysisSeq += 1);
  return new Promise((resolve, reject) => {
    pendingAnalyses.set(id, { resolve, reject });
    getWorker().postMessage({ id, payload }, transfer);
  });
}

// Decode-and-resample stays on the main thread (OfflineAudioContext is unavailable to
// workers); only plain Float32Arrays are transferred so the heavy DSP never blocks the
// UI. Returns the decoded buffer, its RMS, and the full analysis (bpm, beatgrid, bar/
// phrase phase, entry point, key/Camelot) merged into one object ready to use as a deck.
export async function analyzeBuffer(buffer) {
  const [tempoSignal, mono, clap] = await Promise.all([
    renderMono(buffer, { sampleRate: TEMPO_SR, seconds: ANALYSIS_SECONDS }),
    renderMono(buffer, { sampleRate: STRUCTURE_SR, seconds: STRUCTURE_SECONDS }),
    renderMono(buffer, { sampleRate: STRUCTURE_SR, seconds: STRUCTURE_SECONDS, band: 'clap' }),
  ]);
  const analysis = await analyseInWorker(
    { tempoSignal, mono, clap, structureSr: STRUCTURE_SR, duration: buffer.duration },
    [tempoSignal.buffer, mono.buffer, clap.buffer],
  );
  return { buffer, rms: computeRms(buffer), ...analysis };
}
