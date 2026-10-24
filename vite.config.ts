import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages or any sub-path.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 700 }, // three.js alone is ~550 kB
});
