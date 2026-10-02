import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const testPort = Number(process.env.WHITEBOARD_TEST_PORT ?? 3001);
if (!Number.isInteger(testPort) || testPort < 1 || testPort > 65535) throw new Error('WHITEBOARD_TEST_PORT must be an integer from 1 to 65535.');

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: {
    '/api': `http://127.0.0.1:${testPort}`,
    '/collaboration': { target: `ws://127.0.0.1:${testPort}`, ws: true },
  } },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: {
    '/api': `http://127.0.0.1:${testPort}`,
    '/collaboration': { target: `ws://127.0.0.1:${testPort}`, ws: true },
  } },
});
