import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['spikes/model-kv/writer-*.test.ts'], testTimeout: 180_000 } });
