import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

/** The PhotoCraft storyboard, served at /storyboard/ beside the Flow window. */
export default defineConfig({
  root: 'client-storyboard',
  base: '/storyboard/',
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss({ config: './tailwind.storyboard.js' }), autoprefixer()] } },
  build: { outDir: '../client/dist/storyboard', emptyOutDir: true },
});
