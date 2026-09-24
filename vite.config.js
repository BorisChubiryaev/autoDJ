import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Two entry points: the A/B transition lab (index.html) and the Zvuk-style
// continuous player (player.html). Both share the same engine in src/.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        player: resolve(__dirname, 'player.html'),
      },
    },
  },
});
