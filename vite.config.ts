import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  worker: { format: 'es' },
  build: { target: "safari16", minify: "esbuild", sourcemap: false, reportCompressedSize: false, chunkSizeWarningLimit: 5000 },
});
