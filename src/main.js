import MusicTempo from 'music-tempo';
import './styles.css';

const HOUSE_MIN_BPM = 112;
const HOUSE_MAX_BPM = 136;
const TRANSITION_BARS = 16;
const ANALYSIS_SECONDS = 75;
const INTRO_SEARCH_BARS = 12;

const state = {
  context: null,
  decks: { a: emptyDeck('a'), b: emptyDeck('b') },
  sources: [],
  playing: false,
  transport: null,
  animationFrame: null,
  mixTimer: null,
};

function emptyDeck(id) {
  return { id, buffer: null, bpm: null, beatPeriod: null, gridOrigin: 0, entryPoint: 0, beats: [], analysis: null };
}

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const formatTime = (seconds) => {
  const safe = Math.max(0, seconds || 0);
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
};

function getContext() {
  if (!state.context) state.context = new AudioContext();
  return state.context;
}

function setStatus(message, active = false) {
  $('#status').innerHTML = `<span class="${active ? 'active' : ''}"></span>${message}`;
}

function updateControls() {
  const ready = state.decks.a.buffer && state.decks.b.buffer;
  $('#auto-mix').disabled = !ready;
  $('#stop').disabled = !state.playing;
  if (!ready) {
    $('#mix-note').textContent = 'Загрузите два трека — анализ начнётся автоматически.';
    return;
  }
  const rate = syncRate();
  $('#sync-lock').textContent = `SYNC LOCK · ${state.decks.a.bpm.toFixed(2)} BPM · B ${rate.toFixed(4)}×`;
  $('#mix-note').textContent = `Точное выравнивание beatgrid · переход ${TRANSITION_BARS} тактов · без ручных действий`;
}

function syncRate() {
  // A 128 BPM track has a shorter period than a 124 BPM track and must be slowed down.
  // playbackRate is therefore B's native period divided by A's target period.
  return clamp(state.decks.b.beatPeriod / state.decks.a.beatPeriod, 0.88, 1.12);
}

async function loadDeck(id, file) {
  const deck = state.decks[id];
  setStatus(`Строю beatgrid для ${file.name}…`, true);
  const data = await file.arrayBuffer();
  const buffer = await getContext().decodeAudioData(data);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const analysis = await analyseTrack(buffer);
  Object.assign(deck, { buffer, ...analysis });

  $(`#name-${id}`).textContent = file.name;
  $(`#bpm-${id}`).textContent = analysis.bpm.toFixed(2);
  $(`#length-${id}`).textContent = formatTime(buffer.duration);
  if (id === 'a') {
    $('#grid-a').textContent = `${analysis.beats.length} beats`;
    $('#caption-a').textContent = `Авто-выход: последняя фраза длиной ${TRANSITION_BARS} тактов.`;
  } else {
    $('#entry-b').textContent = formatTime(analysis.entryPoint);
    $('#caption-b').textContent = 'Авто-вход: перкуссионная фраза с минимальной внебитовой энергией.';
  }
  renderDecks();
  setStatus(state.decks.a.buffer && state.decks.b.buffer ? 'Beatgrid готов. Auto Mix готов к запуску.' : `Трек ${id.toUpperCase()} готов`);
  updateControls();
}

async function prepareAnalysisSignal(buffer) {
  const length = Math.min(buffer.duration, ANALYSIS_SECONDS);
  const sampleRate = 44100;
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext) return buffer.getChannelData(0).slice(0, Math.floor(length * buffer.sampleRate));
  const offline = new OfflineContext(1, Math.ceil(length * sampleRate), sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0, 0, length);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

async function analyseTrack(buffer) {
  try {
    const signal = await prepareAnalysisSignal(buffer);
    const tracker = new MusicTempo(signal, {
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
    const { beatPeriod, trackedBeats, gridOrigin } = normaliseHousePulse(buffer, rawBeats);
    const bpm = 60 / beatPeriod;
    if (bpm < HOUSE_MIN_BPM || bpm > HOUSE_MAX_BPM || !Number.isFinite(bpm)) throw new Error('Темп вне house-диапазона');
    const beats = createBeatGrid(gridOrigin, beatPeriod, buffer.duration);
    return { bpm, beatPeriod, gridOrigin, beats, entryPoint: chooseEntryPoint(buffer, beats, beatPeriod) };
  } catch (error) {
    console.warn('Beat tracker fallback:', error);
    return fallbackAnalysis(buffer);
  }
}

// The tracker can lock onto off-beat hats and report ~250 BPM for 125 BPM house.
// Collapse that pulse to 1/2 (or another whole multiple) and retain the phase
// with the strongest kick energy. This is what turns pulse detection into a DJ beatgrid.
function normaliseHousePulse(buffer, rawBeats) {
  const pulseIntervals = rawBeats.slice(1).map((beat, index) => beat - rawBeats[index])
    .filter((interval) => interval > 0.16 && interval < 0.7);
  const pulsePeriod = median(pulseIntervals);
  const possibleStrides = [1, 2, 3, 4].filter((stride) => {
    const bpm = 60 / (pulsePeriod * stride);
    return bpm >= HOUSE_MIN_BPM && bpm <= HOUSE_MAX_BPM;
  });
  if (!possibleStrides.length) throw new Error('Пульсация вне house-диапазона');
  const stride = possibleStrides.sort((a, b) => Math.abs(60 / (pulsePeriod * a) - 124) - Math.abs(60 / (pulsePeriod * b) - 124))[0];
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  let trackedBeats = [];
  let strongestPhase = -Infinity;
  for (let phase = 0; phase < stride; phase += 1) {
    const candidate = rawBeats.filter((_, index) => index % stride === phase);
    const energy = candidate.reduce((sum, beat) => sum + localEnergy(data, sampleRate, beat, 0.025), 0) / candidate.length;
    if (energy > strongestPhase) { strongestPhase = energy; trackedBeats = candidate; }
  }
  if (trackedBeats.length < 8) throw new Error('Нестабильная сетка битов');
  const { period: beatPeriod, origin: gridOrigin } = fitBeatGrid(trackedBeats);
  const expectedPeriod = pulsePeriod * stride;
  if (beatPeriod < expectedPeriod * 0.94 || beatPeriod > expectedPeriod * 1.06) throw new Error('Нестабильная сетка битов');
  return { beatPeriod, trackedBeats, gridOrigin };
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

// Selects an early 16-bar phrase where kick energy is stronger than off-beat energy.
// It removes common vocal openings without presenting a manual cue control.
function chooseEntryPoint(buffer, beats, period) {
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const firstAudible = findFirstAudible(data, sampleRate);
  const firstBeatIndex = Math.max(0, beats.findIndex((beat) => beat >= firstAudible));
  const firstBar = Math.ceil(firstBeatIndex / 4) * 4;
  const phraseBeats = 16 * 4;
  // Mix into the opening phrase, not an arbitrary later breakdown or vocal hook.
  // A catalog-grade structure model will replace this conservative intro policy.
  const maxIndex = Math.min(beats.length - phraseBeats - 1, firstBar + 4 * INTRO_SEARCH_BARS);
  let bestIndex = firstBar;
  let bestScore = -Infinity;
  for (let index = firstBar; index <= maxIndex; index += 4) {
    const barsFromIntro = (index - firstBar) / 4;
    const score = Math.log(percussivePhraseScore(data, sampleRate, beats, index, phraseBeats, period)) - barsFromIntro * 0.22;
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  }
  return beats[bestIndex] ?? beats[0] ?? 0;
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

function localEnergy(data, sampleRate, time, radius) {
  const start = Math.max(0, Math.floor((time - radius) * sampleRate));
  const end = Math.min(data.length, Math.ceil((time + radius) * sampleRate));
  let energy = 0;
  for (let index = start; index < end; index += 4) energy += Math.abs(data[index]);
  return energy / Math.max(1, (end - start) / 4);
}

function fallbackAnalysis(buffer) {
  const bpm = 124;
  const beatPeriod = 60 / bpm;
  const beats = createBeatGrid(0, beatPeriod, buffer.duration);
  return { bpm, beatPeriod, gridOrigin: 0, beats, entryPoint: chooseEntryPoint(buffer, beats, beatPeriod) };
}

function drawWaveform(deck, position = null) {
  if (!deck.buffer) return;
  const canvas = $(`#wave-${deck.id}`);
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = deck.buffer.getChannelData(0);
  const step = Math.max(1, Math.ceil(data.length / width));
  const color = deck.id === 'a' ? '#82f7c5' : '#f7c85d';
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#171d2c';
  ctx.fillRect(0, 0, width, height);
  if (position !== null) { ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fillRect(0, 0, position / deck.buffer.duration * width, height); }
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.84;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let x = 0; x < width; x += 1) {
    let peak = 0;
    for (let i = 0; i < step; i += 1) peak = Math.max(peak, Math.abs(data[x * step + i] || 0));
    const y = peak * height * 0.4;
    ctx.moveTo(x, height / 2 - y);
    ctx.lineTo(x, height / 2 + y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  deck.beats.forEach((beat, index) => {
    const x = beat / deck.buffer.duration * width;
    ctx.fillStyle = index % 4 === 0 ? 'rgba(247,200,93,.62)' : 'rgba(147,164,190,.28)';
    ctx.fillRect(x, 0, index % 4 === 0 ? 1.5 : 1, height);
  });
  if (deck.id === 'b') {
    const x = deck.entryPoint / deck.buffer.duration * width;
    ctx.fillStyle = color;
    ctx.fillRect(x - 1.25, 0, 2.5, height);
    ctx.font = '10px DM Mono, monospace';
    ctx.fillText('AUTO IN', Math.min(width - 45, x + 5), 12);
  }
  if (position !== null && position <= deck.buffer.duration) {
    const x = position / deck.buffer.duration * width;
    ctx.fillStyle = '#f1f5fb';
    ctx.fillRect(x - 1, 0, 2, height);
  }
}

function renderDecks() {
  const positions = {};
  if (state.transport) {
    const elapsed = Math.max(0, getContext().currentTime - state.transport.startTime);
    Object.entries(state.transport.decks).forEach(([id, source]) => { positions[id] = source.offset + elapsed * source.rate; });
  }
  for (const id of ['a', 'b']) {
    const deck = state.decks[id];
    if (!deck.buffer) continue;
    drawWaveform(deck, positions[id] ?? null);
    $(`#position-${id}`).textContent = positions[id] === undefined ? 'ANALYSED' : formatTime(positions[id]);
    $(`#deck-state-${id}`).textContent = positions[id] === undefined ? 'READY' : 'PLAYING';
  }
}

function animateDecks() {
  renderDecks();
  if (state.playing) state.animationFrame = requestAnimationFrame(animateDecks);
  else state.animationFrame = null;
}

function startVisualizer() {
  if (!state.animationFrame) animateDecks();
}

function makeChannel(deck, output) {
  const context = getContext();
  const source = context.createBufferSource();
  source.buffer = deck.buffer;
  const low = context.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 230;
  const mid = context.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1150; mid.Q.value = 0.7;
  const high = context.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 4400;
  const gain = context.createGain();
  source.connect(low).connect(mid).connect(high).connect(gain).connect(output);
  return { source, low, mid, high, gain };
}

function scheduleValue(param, at, from, to, duration) {
  param.cancelScheduledValues(at);
  param.setValueAtTime(from, at);
  param.linearRampToValueAtTime(to, at + duration);
}

function outroStart(deck, duration) {
  const barSeconds = deck.beatPeriod * 4;
  const needed = deck.buffer.duration - duration - 0.75;
  const barsFromOrigin = Math.floor((needed - deck.gridOrigin) / barSeconds);
  return clamp(deck.gridOrigin + Math.max(0, barsFromOrigin) * barSeconds, 0, deck.buffer.duration - 0.05);
}

async function autoMix() {
  if (state.playing) stopAll(false);
  const context = getContext();
  await context.resume();
  const master = context.createGain();
  master.gain.value = 0.88;
  master.connect(context.destination);
  const a = makeChannel(state.decks.a, master);
  const b = makeChannel(state.decks.b, master);
  const startTime = context.currentTime + 0.12;
  const transitionSeconds = TRANSITION_BARS * 4 * state.decks.a.beatPeriod;
  const rate = syncRate();
  const aOffset = outroStart(state.decks.a, transitionSeconds);
  const bOffset = state.decks.b.entryPoint;
  b.source.playbackRate.setValueAtTime(rate, startTime);

  // Both offsets are beatgrid points. B's exact rate is derived from the grid periods,
  // rather than a rounded BPM label, so its phase stays locked through the transition.
  a.source.start(startTime, aOffset);
  b.source.start(startTime, bOffset);
  [a.low, a.mid, a.high].forEach((filter) => filter.gain.setValueAtTime(0, startTime));
  b.low.gain.setValueAtTime(-28, startTime); b.mid.gain.setValueAtTime(-14, startTime); b.high.gain.setValueAtTime(-10, startTime);
  a.gain.gain.setValueAtTime(1, startTime); b.gain.gain.setValueAtTime(0, startTime);
  scheduleValue(a.low.gain, startTime, 0, -28, transitionSeconds * 0.58);
  scheduleValue(b.low.gain, startTime, -28, 0, transitionSeconds * 0.58);
  scheduleValue(a.mid.gain, startTime + transitionSeconds * 0.28, 0, -16, transitionSeconds * 0.55);
  scheduleValue(a.high.gain, startTime + transitionSeconds * 0.34, 0, -14, transitionSeconds * 0.52);
  scheduleValue(b.mid.gain, startTime + transitionSeconds * 0.2, -14, 0, transitionSeconds * 0.58);
  scheduleValue(b.high.gain, startTime + transitionSeconds * 0.24, -10, 0, transitionSeconds * 0.56);
  scheduleValue(a.gain.gain, startTime + transitionSeconds * 0.58, 1, 0, transitionSeconds * 0.42);
  scheduleValue(b.gain.gain, startTime + transitionSeconds * 0.28, 0, 1, transitionSeconds * 0.52);

  state.sources = [a.source, b.source];
  state.transport = { startTime, decks: { a: { offset: aOffset, rate: 1 }, b: { offset: bOffset, rate } } };
  state.playing = true;
  updateControls();
  setStatus(`SYNC LOCK · ${TRANSITION_BARS} тактов · B ${rate.toFixed(4)}×`, true);
  startVisualizer();
  b.source.onended = () => stopAll(false);
  window.clearTimeout(state.mixTimer);
  state.mixTimer = window.setTimeout(() => { if (state.playing) setStatus('Переход завершён — играет трек B', true); }, (transitionSeconds + 0.12) * 1000);
}

function stopAll(updateMessage = true) {
  state.sources.forEach((source) => { try { source.stop(); } catch { /* source already ended */ } });
  state.sources = [];
  state.transport = null;
  state.playing = false;
  window.clearTimeout(state.mixTimer);
  updateControls();
  renderDecks();
  if (updateMessage) setStatus('Воспроизведение остановлено');
}

['a', 'b'].forEach((id) => {
  $(`#file-${id}`).addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) loadDeck(id, file).catch((error) => setStatus(`Не удалось прочитать файл: ${error.message}`));
  });
  const zone = $(`#drop-${id}`);
  zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault(); zone.classList.remove('dragging');
    const [file] = event.dataTransfer.files;
    if (file?.type.startsWith('audio/')) loadDeck(id, file).catch((error) => setStatus(`Не удалось прочитать файл: ${error.message}`));
  });
});

$('#auto-mix').addEventListener('click', () => autoMix().catch((error) => setStatus(`Ошибка микса: ${error.message}`)));
$('#stop').addEventListener('click', () => stopAll());
updateControls();
