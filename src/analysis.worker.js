// Runs the beatgrid/structure analysis off the main thread so the UI never blocks.
// Decoding and resampling stay on the main thread — OfflineAudioContext is not
// available to workers — and only plain Float32Arrays are transferred in.
import { analyseTrack } from './analysis.js';

self.onmessage = (event) => {
  const { id, payload } = event.data;
  try {
    self.postMessage({ id, ok: true, result: analyseTrack(payload) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message });
  }
};
