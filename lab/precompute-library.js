// Dev-only: runs the full beatgrid/structure/key analysis for every curated LIBRARY
// track once and returns it as a plain JSON-able object (no AudioBuffer). Run against
// the dev server after music/ tracks change, e.g. from the browser console:
//
//   const { precomputeLibrary } = await import('/lab/precompute-library.js');
//   copy(JSON.stringify(await precomputeLibrary()))
//
// then paste the result into public/music/analysis.json. src/player.js reads that
// file at load time so the production player doesn't re-run this DSP on every visit.
import { analyzeBuffer } from '/src/analyze-audio.js';
import { LIBRARY } from '/src/library.js';

export async function precomputeLibrary() {
  const out = {};
  for (const item of LIBRARY) {
    const res = await fetch(`/music/${item.file}`);
    if (!res.ok) throw new Error(`Не найден трек: ${item.file} (${res.status})`);
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    const { buffer: _buffer, ...analysis } = await analyzeBuffer(buffer);
    out[item.file] = analysis;
    await ctx.close();
  }
  return out;
}
