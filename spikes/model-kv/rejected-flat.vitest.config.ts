import { defineConfig } from 'vitest/config';
/** Intentional reproduction of the rejected global-array design's semantic failures. */
export default defineConfig({ test: { include: ['spikes/model-kv/model.test.ts'] } });
