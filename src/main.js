import './styles.css';
import { PHRASE_BARS, phraseDownbeatIndex, harmonicMatch } from './analysis.js';
import {
  TRANSITION_BARS, MAX_TEMPO_STRETCH, tempoPlan, makeChannel, makeMaster,
  outroStart, scheduleCrossfade, clamp,
} from './mixer.js';
import { analyzeBuffer } from './analyze-audio.js';

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
  return {
    id, buffer: null, bpm: null, beatPeriod: null, gridOrigin: 0, entryPoint: 0,
    beats: [], barPhase: 0, phrasePhase: 0, rms: 1,
  };
}

const $ = (selector) => document.querySelector(selector);
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
  const plan = tempoPlan(state.decks.a.beatPeriod, state.decks.b.beatPeriod);
  const harmony = harmonicMatch(state.decks.a, state.decks.b, plan.rateA, plan.rateB);
  $('#sync-lock').textContent = `SYNC LOCK · ${plan.commonBpm.toFixed(2)} BPM · ${state.decks.a.camelot} → ${state.decks.b.camelot}`;
  if (!plan.feasible) {
    $('#mix-note').textContent = `⚠ Разница темпов больше ${Math.round(MAX_TEMPO_STRETCH * 200)}% — сведение будет расходиться по фазе`;
    return;
  }
  $('#mix-note').textContent = `${harmonyNote(harmony)} · переход ${TRANSITION_BARS} тактов`;
}

function harmonyNote(harmony) {
  const detune = `расстройка ${harmony.detune >= 0 ? '+' : ''}${harmony.detune.toFixed(2)} полутона`;
  const verdict = {
    perfect: 'Тональности совпадают',
    relative: 'Параллельные тональности',
    neighbour: 'Соседи по кругу Camelot',
    clash: '⚠ Тональности не сочетаются',
    unknown: 'Тональность определена неуверенно',
  }[harmony.level];
  if (harmony.level !== 'clash' && harmony.level !== 'unknown' && harmony.detuneHeavy) {
    return `${verdict}, но ${detune} от подгонки темпа — гармонию смажет`;
  }
  return `${verdict} · ${detune}`;
}

async function loadDeck(id, file) {
  const deck = state.decks[id];
  setStatus(`Строю beatgrid для ${file.name}…`, true);
  const buffer = await getContext().decodeAudioData(await file.arrayBuffer());
  const analysis = await analyzeBuffer(buffer);
  if (analysis.error) console.warn('Beat tracker fallback:', analysis.error);
  Object.assign(deck, analysis);

  $(`#name-${id}`).textContent = file.name;
  $(`#bpm-${id}`).textContent = analysis.bpm.toFixed(2);
  $(`#length-${id}`).textContent = formatTime(buffer.duration);
  const barNote = analysis.barConfident
    ? `даунбит +${analysis.barPhase}, фраза с ${analysis.phrasePhase}-го такта`
    : `даунбит по сетке, фраза с ${analysis.phrasePhase}-го такта`;
  const keyNote = analysis.keyConfident
    ? `${analysis.key} · ${analysis.camelot}`
    : `${analysis.key}? (или ${analysis.keyAlternative})`;
  if (id === 'a') {
    $('#grid-a').textContent = `${analysis.beats.length} beats`;
    $('#caption-a').textContent = `${keyNote} · авто-выход: последняя полная фраза (${barNote}).`;
  } else {
    $('#entry-b').textContent = formatTime(analysis.entryPoint);
    $('#caption-b').textContent = `${keyNote} · авто-вход: перкуссионная фраза (${barNote}).`;
  }
  renderDecks();
  setStatus(state.decks.a.buffer && state.decks.b.buffer ? 'Beatgrid готов. Auto Mix готов к запуску.' : `Трек ${id.toUpperCase()} готов`);
  updateControls();
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
  // Grid lines follow the detected downbeat, so bars and phrases mark real musical
  // boundaries rather than an arbitrary offset into the beat grid.
  const phraseBeats = PHRASE_BARS * 4;
  const phraseAnchor = deck.barPhase + 4 * deck.phrasePhase;
  deck.beats.forEach((beat, index) => {
    const isBar = ((index - deck.barPhase) % 4 + 4) % 4 === 0;
    const isPhrase = ((index - phraseAnchor) % phraseBeats + phraseBeats) % phraseBeats === 0;
    if (!isBar) return;
    const x = beat / deck.buffer.duration * width;
    ctx.fillStyle = isPhrase ? 'rgba(247,200,93,.75)' : 'rgba(147,164,190,.28)';
    ctx.fillRect(x, 0, isPhrase ? 1.5 : 1, height);
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

// Latest real phrase downbeat of a deck, bound to its detected bar/phrase phase.
const deckOutroStart = (deck, duration) => outroStart(
  deck, duration,
  (k) => deck.beats[phraseDownbeatIndex(deck.barPhase, deck.phrasePhase, k)],
);

async function autoMix() {
  if (state.playing) stopAll(false);
  const context = getContext();
  await context.resume();

  const master = makeMaster(context);
  const a = makeChannel(context, state.decks.a.buffer, master);
  const b = makeChannel(context, state.decks.b.buffer, master);

  const plan = tempoPlan(state.decks.a.beatPeriod, state.decks.b.beatPeriod);
  const startTime = context.currentTime + 0.12;
  const transitionSeconds = TRANSITION_BARS * 4 * plan.common;
  const aOutroLen = TRANSITION_BARS * 4 * state.decks.a.beatPeriod;
  const aOffset = deckOutroStart(state.decks.a, aOutroLen);
  const bOffset = state.decks.b.entryPoint;
  // Level-match B to A so the crossfade holds a steady perceived loudness.
  const matchB = clamp(state.decks.a.rms / state.decks.b.rms, 0.5, 2.0);

  // Both offsets are real phrase downbeats and both decks meet at the common tempo,
  // so bar phase stays locked and the pitch shift is split evenly between the tracks.
  a.source.playbackRate.setValueAtTime(plan.rateA, startTime);
  b.source.playbackRate.setValueAtTime(plan.rateB, startTime);
  a.source.start(startTime, aOffset);
  b.source.start(startTime, bOffset);

  scheduleCrossfade({
    out: a, in: b, startTime, common: plan.common, transitionSeconds,
    outLevel: 1, inLevel: matchB,
  });

  state.sources = [a.source, b.source];
  state.transport = { startTime, decks: { a: { offset: aOffset, rate: plan.rateA }, b: { offset: bOffset, rate: plan.rateB } } };
  state.playing = true;
  updateControls();
  setStatus(`SYNC LOCK · ${TRANSITION_BARS} тактов · ${plan.commonBpm.toFixed(1)} BPM`, true);
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
