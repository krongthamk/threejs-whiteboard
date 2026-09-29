import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        renderer: fileURLToPath(new URL('./renderer/index.html', import.meta.url)),
        text: fileURLToPath(new URL('./text/index.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      '@whiteboard/model': fileURLToPath(new URL('../packages/model/src/index.ts', import.meta.url)),
      '@whiteboard/renderer': fileURLToPath(new URL('../packages/renderer/src/index.ts', import.meta.url)),
    },
  },
})
