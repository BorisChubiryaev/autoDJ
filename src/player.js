import './player.css';
import { harmonicMatch } from './analysis.js';
import {
  TRANSITION_BARS, MAX_TEMPO_STRETCH, makeChannel, makeMaster,
  outroStart, scheduleCrossfade, clamp,
} from './mixer.js';
import { analyzeBuffer } from './analyze-audio.js';

// Curated demo queue. music/ is gitignored and served straight from the dev root,
// so tracks are fetched by URL rather than bundled. Edit this list to reorder the set.
const LIBRARY = [
  { file: 'Fisher_-_Losing_It_76934851.mp3', artist: 'Fisher', title: 'Losing It' },
  { file: 'Fisher_-_Stop_It_82000120.mp3', artist: 'Fisher', title: 'Stop It' },
  { file: 'Mall_Grab_-_Pool_Party_Music_50268829.mp3', artist: 'Mall Grab', title: 'Pool Party Music' },
  { file: 'Mall_Grab_-_Feelin_Good_55486971.mp3', artist: 'Mall Grab', title: "Feelin' Good" },
  { file: 'Benny_Benassi_-_Satisfaction_69560247.mp3', artist: 'Benny Benassi', title: 'Satisfaction' },
];

const $ = (sel) => document.querySelector(sel);
const fmt = (s) => { const v = Math.max(0, s || 0); return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`; };

// Deterministic gradient art per track, so the queue reads like real cover thumbnails.
function hue(str) { let h = 0; for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) % 360; return h; }
function artCss(str) { const a = hue(str); const b = (a + 55) % 360; return `linear-gradient(135deg, hsl(${a} 62% 42%), hsl(${b} 58% 26%))`; }

// ~900-point peak envelope for fast canvas redraws every animation frame.
function peaks(buffer, n = 900) {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / n));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let p = 0;
    const start = i * step;
    for (let j = 0; j < step; j += 8) { const v = Math.abs(data[start + j] || 0); if (v > p) p = v; }
    out[i] = p;
  }
  return out;
}

const state = {
  ctx: null,
  decks: [],            // analyzed tracks: curated LIBRARY entries + uploads, in play order
  commonPeriod: null,   // set tempo
  rates: [],            // per-track playbackRate to reach the set tempo
  master: null,
  sources: [],
  transport: null,      // { t0, tl } while a set is scheduled
  paused: false,
  raf: null,
  currentIndex: 0,
};
let uploadSeq = 0;

// "Artist_-_Title_12345.mp3" -> { artist, title }; falls back to the whole name.
function parseUploadName(filename) {
  const base = filename.replace(/\.[^./]+$/, '').replace(/_/g, ' ').trim();
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return { artist: 'Загружено', title: base || filename };
}

const getCtx = () => (state.ctx || (state.ctx = new AudioContext()));

// The k-th real phrase downbeat of a deck, bound to its detected bar/phrase phase.
const phraseDownbeat = (deck, k) => {
  const idx = deck.barPhase + 4 * deck.phrasePhase + TRANSITION_BARS * 4 * k;
  return deck.beats[idx];
};
const deckOutroStart = (deck, duration) => outroStart(deck, duration, (k) => phraseDownbeat(deck, k));
const soloLevel = (i) => (i === 0 ? 1 : clamp(state.decks[0].rms / state.decks[i].rms, 0.5, 2.0));

// ---- load & analyze the whole set up front ----------------------------------
// music/ is gitignored and served straight from the dev root, so the curated demo
// tracks only exist on machines that have them locally — anyone else opens this with
// an empty library. Missing files are skipped rather than treated as fatal, so the
// player always lands in a usable state: either the curated set, or an empty queue
// ready for uploads.
async function loadSet() {
  const ctx = getCtx();
  for (let i = 0; i < LIBRARY.length; i += 1) {
    const item = LIBRARY[i];
    $('#loading-detail').textContent = `${i + 1}/${LIBRARY.length} · ${item.artist} — ${item.title}`;
    try {
      const res = await fetch(`/music/${item.file}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      const analysis = await analyzeBuffer(buffer);
      state.decks.push({ ...item, ...analysis, peaks: peaks(buffer) });
    } catch (err) {
      console.warn(`Пропускаю демо-трек ${item.file}:`, err.message);
    }
  }
  finishLoad();
}

function finishLoad() {
  if (state.decks.length && !state.commonPeriod) {
    // Set tempo = median beat period; every track meets there. House tracks sit within
    // a few percent of it, well inside the ±MAX_TEMPO_STRETCH budget.
    const periods = state.decks.map((d) => d.beatPeriod).sort((a, b) => a - b);
    state.commonPeriod = periods[Math.floor(periods.length / 2)];
    state.rates = state.decks.map((d) => clamp(
      d.beatPeriod / state.commonPeriod, 1 - MAX_TEMPO_STRETCH, 1 + MAX_TEMPO_STRETCH,
    ));
  }
  renderQueue();
  $('#loading').style.display = 'none';
  const hasDecks = state.decks.length > 0;
  ['#play', '#next', '#mixnow', '#hero-play'].forEach((s) => { $(s).disabled = !hasDecks; });
  if (hasDecks) {
    $('#bar-artist').textContent = 'Готово — нажмите ▶';
    setNowPlaying(0);
  } else {
    $('#bar-artist').textContent = 'Добавьте треки, чтобы собрать сет';
  }
}

// ---- user uploads -------------------------------------------------------------
// Uploaded tracks join the same deck/rate arrays the curated set uses, so every
// downstream step (timeline, crossfade, queue UI) treats them identically.
async function handleUpload(files) {
  const input = $('#file-upload');
  const status = $('#upload-status');
  input.disabled = true;
  const wasEmpty = state.decks.length === 0;
  let hadError = false;
  for (const file of files) {
    status.textContent = `Анализирую «${file.name}»…`;
    try {
      const ctx = getCtx();
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      const analysis = await analyzeBuffer(buffer);
      uploadSeq += 1;
      const deck = {
        file: `upload-${uploadSeq}-${file.name}`, ...parseUploadName(file.name), ...analysis, peaks: peaks(buffer),
      };
      if (!state.commonPeriod) state.commonPeriod = deck.beatPeriod;
      state.decks.push(deck);
      state.rates.push(clamp(
        deck.beatPeriod / state.commonPeriod, 1 - MAX_TEMPO_STRETCH, 1 + MAX_TEMPO_STRETCH,
      ));
    } catch (err) {
      console.error(err);
      hadError = true;
      status.textContent = `Не удалось разобрать «${file.name}»: ${err.message}`;
    }
  }
  if (!hadError) status.textContent = '';
  input.value = '';
  input.disabled = false;
  renderQueue();
  const hasDecks = state.decks.length > 0;
  ['#play', '#next', '#mixnow', '#hero-play'].forEach((s) => { $(s).disabled = !hasDecks; });
  if (wasEmpty && hasDecks) { setNowPlaying(0); $('#bar-artist').textContent = 'Готово — нажмите ▶'; }
  // If a set is already playing, fold the new track(s) into the live timeline instead
  // of only appending to the queue — same click-free reschedule used by skip/mixNow.
  if (state.transport) {
    const seg = currentSegment();
    const wall = getCtx().currentTime;
    const pos = seg.inOffset + Math.max(0, wall - seg.startWall) * seg.rate;
    scheduleFrom(seg.i, pos);
  }
}

// ---- timeline ---------------------------------------------------------------
// Every track plays at the set tempo for its whole solo section — no mid-track rate
// change. A transition begins the instant the outgoing track reaches its outro phrase
// downbeat; the incoming track starts there from its entry point. Because both sit at
// the common period, the outro/transition window is TRANSITION_BARS*4*commonPeriod wall
// seconds for every pair.
function buildTimeline(fromIndex, fromOffset, t0) {
  const P = state.commonPeriod;
  const L = TRANSITION_BARS * 4 * P;
  const tl = [];
  let startWall = t0;
  for (let i = fromIndex; i < state.decks.length; i += 1) {
    const deck = state.decks[i];
    const rate = state.rates[i];
    const inOffset = i === fromIndex ? fromOffset : deck.entryPoint;
    const isLast = i === state.decks.length - 1;
    const seg = { i, deck, rate, inOffset, isLast, startWall, level: soloLevel(i) };
    if (!isLast) {
      const outroLen = TRANSITION_BARS * 4 * deck.beatPeriod;
      seg.outOffset = Math.max(inOffset, deckOutroStart(deck, outroLen));
      seg.transitionStartWall = startWall + (seg.outOffset - inOffset) / rate;
      startWall = seg.transitionStartWall;
    } else {
      seg.endWall = startWall + (deck.buffer.duration - inOffset) / rate;
    }
    tl.push(seg);
  }
  return { tl, L, P };
}

// ---- scheduling -------------------------------------------------------------
const RESCHEDULE_FADE = 0.22; // short master crossfade so user actions never hard-cut

function stopSet(silent = true) {
  state.sources.forEach((s) => { try { s.onended = null; s.stop(); } catch { /* already ended */ } });
  state.sources = [];
  state.transport = null;
  state.paused = false;
  if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
  if (!silent) updatePlayIcon();
}

// Fades the currently-playing schedule down over RESCHEDULE_FADE and stops its sources
// just after, instead of cutting them dead — this is what removes the click the user
// heard on every "к сведе́нию" / skip / queue click.
function fadeOutCurrent(now) {
  const prevMaster = state.master;
  if (prevMaster) {
    const g = prevMaster.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + RESCHEDULE_FADE);
  }
  state.sources.forEach((s) => { try { s.onended = null; s.stop(now + RESCHEDULE_FADE + 0.03); } catch { /* ended */ } });
  state.sources = [];
  state.transport = null;
  state.paused = false;
  if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
}

async function scheduleFrom(fromIndex, fromOffset) {
  const ctx = getCtx();
  await ctx.resume();
  const now = ctx.currentTime;
  fadeOutCurrent(now);
  // New schedule starts inside the old fade tail so the two briefly overlap (no gap).
  const t0 = now + RESCHEDULE_FADE * 0.5;
  const built = buildTimeline(fromIndex, fromOffset, t0);
  state.master = makeMaster(ctx);
  // Ease the new master in so the first track doesn't pop in over the outgoing tail.
  const level = state.master.gain.value;
  state.master.gain.setValueAtTime(0, t0);
  state.master.gain.linearRampToValueAtTime(level, t0 + RESCHEDULE_FADE);

  built.tl.forEach((seg, idx) => {
    const ch = makeChannel(ctx, seg.deck.buffer, state.master);
    ch.source.playbackRate.value = seg.rate;
    if (idx === 0) ch.gain.gain.value = seg.level; // first scheduled track: no fade-in
    ch.source.start(seg.startWall, seg.inOffset);
    seg.channel = ch;
    seg.source = ch.source;
    state.sources.push(ch.source);
  });

  for (let idx = 0; idx < built.tl.length - 1; idx += 1) {
    const out = built.tl[idx];
    const inc = built.tl[idx + 1];
    scheduleCrossfade({
      out: out.channel, in: inc.channel, startTime: out.transitionStartWall,
      common: built.P, transitionSeconds: built.L, outLevel: out.level, inLevel: inc.level,
    });
    out.source.stop(out.transitionStartWall + built.L + 0.2);
  }
  const last = built.tl[built.tl.length - 1];
  last.source.onended = () => { if (state.transport) { stopSet(false); onSetEnded(); } };

  state.transport = { t0, ...built };
  state.paused = false;
  updatePlayIcon();
  loop();
}

function onSetEnded() {
  setNowPlaying(state.decks.length - 1);
  $('#amix-val').textContent = 'сет сыгран';
  $('#amix').classList.remove('live');
}

// ---- transport controls -----------------------------------------------------
async function togglePlay() {
  const ctx = getCtx();
  if (!state.transport) { await scheduleFrom(state.currentIndex || 0, state.currentIndex ? state.decks[state.currentIndex].entryPoint : 0); return; }
  if (state.paused) { await ctx.resume(); state.paused = false; loop(); }
  else { await ctx.suspend(); state.paused = true; if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; } }
  updatePlayIcon();
}

const skipTo = (index) => { const i = clamp(index, 0, state.decks.length - 1); scheduleFrom(i, i === 0 ? 0 : state.decks[i].entryPoint); };

// Fast-forward the current track to ~8 bars before its outro, so the auto-mix into the
// next track happens within seconds — the whole point of the demo, without the wait.
function mixNow() {
  const seg = currentSegment();
  const i = seg ? seg.i : (state.currentIndex || 0);
  if (i >= state.decks.length - 1) return;
  const deck = state.decks[i];
  const outroLen = TRANSITION_BARS * 4 * deck.beatPeriod;
  const outro = Math.max(0, deckOutroStart(deck, outroLen));
  const lead = 8 * 4 * deck.beatPeriod; // 8 bars of run-up before the blend
  scheduleFrom(i, Math.max(deck.entryPoint, outro - lead));
}

function updatePlayIcon() {
  const playing = state.transport && !state.paused;
  $('#play').textContent = playing ? '⏸' : '▶';
  $('#hero-play-ico').textContent = playing ? '⏸' : '▶';
  $('#hero-play-lbl').textContent = playing ? 'Пауза' : 'Слушать сет';
}

// ---- playback position & UI loop -------------------------------------------
// Last track whose source has started — used by mixNow / resume to know the head.
function currentSegment() {
  if (!state.transport) return null;
  const wall = getCtx().currentTime;
  const { tl } = state.transport;
  let cur = tl[0];
  for (const seg of tl) { if (seg.startWall <= wall + 1e-3) cur = seg; else break; }
  return cur;
}

// The transition (out → in) whose blend window contains `wall`, or null.
function activeTransition(wall) {
  const { tl, L } = state.transport;
  for (let idx = 0; idx < tl.length - 1; idx += 1) {
    const out = tl[idx];
    if (wall >= out.transitionStartWall - 1e-3 && wall <= out.transitionStartWall + L) {
      return { out, inc: tl[idx + 1] };
    }
  }
  return null;
}

function loop() {
  render();
  if (state.transport && !state.paused) state.raf = requestAnimationFrame(loop);
}

function render() {
  if (!state.transport) return;
  const wall = getCtx().currentTime;
  const trans = activeTransition(wall);

  // During a blend the outgoing track stays "now playing" so you watch its playhead
  // sweep into the highlighted auto-mix zone; it flips to the incoming track only once
  // the blend finishes.
  let seg = state.transport.tl[0];
  if (trans) seg = trans.out;
  else for (const s of state.transport.tl) { if (s.startWall <= wall + 1e-3) seg = s; else break; }

  const pos = seg.inOffset + Math.max(0, wall - seg.startWall) * seg.rate;
  if (seg.i !== state.currentIndex) { state.currentIndex = seg.i; setNowPlaying(seg.i); renderQueue(); }
  updateAmix(seg, trans, wall);

  $('#time-cur').textContent = fmt(pos);
  $('#time-dur').textContent = fmt(seg.deck.buffer.duration);
  drawWave(seg, pos, !!trans);
}

function setNowPlaying(i) {
  const d = state.decks[i];
  if (!d) return;
  const art = artCss(d.file);
  $('#bar-thumb').style.background = art;
  $('#bar-title').textContent = d.title;
  $('#bar-artist').textContent = d.artist;
  $('#hero-cover').style.background = art;
  $('#hero-bars').innerHTML = Array.from({ length: 22 }, () => `<span style="height:${18 + Math.random() * 78}%"></span>`).join('');
}

// The star of the demo: shows the engine's live decision — set tempo, per-deck tempo
// nudge, and the Camelot harmony verdict between the two blending tracks.
function updateAmix(seg, trans, wall) {
  const el = $('#amix');
  el.classList.toggle('live', !!trans);
  if (trans) {
    const a = trans.out.deck;
    const b = trans.inc.deck;
    const harmony = harmonicMatch(a, b, state.rates[trans.out.i], state.rates[trans.inc.i]);
    const verdict = { perfect: 'ключи совпали', relative: 'параллельные', neighbour: 'соседи', clash: '⚠ конфликт', unknown: 'ключ неточно' }[harmony.level];
    const progress = clamp(Math.round(((wall - trans.out.transitionStartWall) / state.transport.L) * 100), 0, 100);
    $('#amix-lbl').textContent = 'СВЕДЕНИЕ';
    $('#amix-val').textContent = `${(60 / state.commonPeriod).toFixed(1)} BPM · ${a.camelot}→${b.camelot} ${verdict} · ${progress}%`;
  } else {
    const nudge = ((state.rates[seg.i] - 1) * 100);
    $('#amix-lbl').textContent = 'AUTO-MIX';
    $('#amix-val').textContent = seg.isLast
      ? `${seg.deck.bpm.toFixed(1)} BPM · финал`
      : `${(60 / state.commonPeriod).toFixed(1)} BPM сет · нудж ${nudge >= 0 ? '+' : ''}${nudge.toFixed(1)}%`;
  }
}

function renderQueue() {
  const q = $('#queue');
  if (!state.decks.length) {
    q.innerHTML = '<div class="zv-empty">Очередь пуста — добавьте треки кнопкой выше, и сет соберётся прямо в браузере.</div>';
    return;
  }
  q.innerHTML = state.decks.map((d, i) => {
    const key = d.keyConfident ? d.camelot : `${d.camelot}?`;
    const on = i === state.currentIndex && state.transport ? ' on' : '';
    const nextTag = state.transport && i === state.currentIndex + 1 ? '<span class="zv-tag-next">СЛЕДУЮЩИЙ</span>' : '';
    return `
      <div class="zv-row${on}" data-i="${i}">
        <div class="idx"><span>${i + 1}</span><span class="eq"><b></b><b></b><b></b></span></div>
        <div class="zv-cell-track">
          <div class="zv-thumb" style="background:${artCss(d.file)}"></div>
          <div class="zv-tt"><div class="t">${d.title}${nextTag}</div><div class="a">${d.artist}</div></div>
        </div>
        <div class="zv-meta bpm">${d.bpm.toFixed(1)} BPM</div>
        <div class="zv-meta"><span class="k">${key}</span></div>
        <div class="zv-meta">${fmt(d.buffer.duration)}</div>
      </div>`;
  }).join('');
  q.querySelectorAll('.zv-row').forEach((row) => {
    row.addEventListener('click', () => skipTo(Number(row.dataset.i)));
  });
}

// ---- waveform ---------------------------------------------------------------
function drawWave(seg, pos, inTransition) {
  const canvas = $('#wave');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const p = seg.deck.peaks;
  const mid = height / 2;
  ctx.clearRect(0, 0, width, height);

  const played = pos / seg.deck.buffer.duration;
  const outroX = seg.outOffset !== undefined ? (seg.outOffset / seg.deck.buffer.duration) * width : width;

  // Outro / auto-mix zone shaded ahead of the playhead.
  if (seg.outOffset !== undefined) {
    ctx.fillStyle = inTransition ? 'rgba(166,226,46,.14)' : 'rgba(166,226,46,.07)';
    ctx.fillRect(outroX, 0, width - outroX, height);
  }

  for (let x = 0; x < width; x += 1) {
    const v = p[Math.floor((x / width) * p.length)] || 0;
    const h = Math.max(1, v * height * 0.86);
    const frac = x / width;
    if (frac <= played) ctx.fillStyle = '#eef1f6';
    else if (seg.outOffset !== undefined && frac >= outroX / width) ctx.fillStyle = '#a6e22e';
    else ctx.fillStyle = '#3a3f4b';
    ctx.fillRect(x, mid - h / 2, 1, h);
  }
  // Playhead
  const px = played * width;
  ctx.fillStyle = '#a6e22e';
  ctx.fillRect(px - 1, 0, 2, height);
}

// ---- wire up ----------------------------------------------------------------
$('#play').addEventListener('click', () => togglePlay().catch(reportError));
$('#hero-play').addEventListener('click', () => togglePlay().catch(reportError));
$('#next').addEventListener('click', () => skipTo((state.currentIndex || 0) + 1));
$('#prev').addEventListener('click', () => skipTo((state.currentIndex || 0) - 1));
$('#mixnow').addEventListener('click', () => mixNow());

$('#file-upload').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length) handleUpload(files).catch(reportError);
});
const uploadRow = $('.zv-upload-row');
['dragover', 'dragenter'].forEach((ev) => uploadRow.addEventListener(ev, (e) => { e.preventDefault(); uploadRow.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((ev) => uploadRow.addEventListener(ev, () => uploadRow.classList.remove('dragging')));
uploadRow.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('audio/'));
  if (files.length) handleUpload(files).catch(reportError);
});

const aboutOverlay = $('#about-overlay');
const openAbout = () => { aboutOverlay.hidden = false; };
const closeAbout = () => { aboutOverlay.hidden = true; };
$('#about-btn').addEventListener('click', openAbout);
$('#about-close').addEventListener('click', closeAbout);
aboutOverlay.addEventListener('click', (e) => { if (e.target === aboutOverlay) closeAbout(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !aboutOverlay.hidden) closeAbout(); });

function reportError(err) {
  console.error(err);
  $('#bar-artist').textContent = `Ошибка: ${err.message}`;
}

loadSet().catch((err) => {
  console.error(err);
  finishLoad();
});
