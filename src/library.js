// Curated demo queue metadata — shared by the player (src/player.js) and the offline
// precompute script (lab/precompute-library.js) so the file list never drifts between
// the two. Files live in public/music/ so Vite copies them into dist/ verbatim on
// build (anything outside public/ is dropped from the production build).
export const LIBRARY = [
  { file: 'Fisher_-_Losing_It_76934851.mp3', artist: 'Fisher', title: 'Losing It' },
  { file: 'Fisher_-_Stop_It_82000120.mp3', artist: 'Fisher', title: 'Stop It' },
  { file: 'Mall_Grab_-_Pool_Party_Music_50268829.mp3', artist: 'Mall Grab', title: 'Pool Party Music' },
  { file: 'Mall_Grab_-_Feelin_Good_55486971.mp3', artist: 'Mall Grab', title: "Feelin' Good" },
  { file: 'Benny_Benassi_-_Satisfaction_69560247.mp3', artist: 'Benny Benassi', title: 'Satisfaction' },
];
