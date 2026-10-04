import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Troika's legacy UMD main calls require('three'). Select its published ESM
    // entry points explicitly, as Vite already does in the browser build.
    alias: [
      { find: /^troika-three-text$/, replacement: 'troika-three-text/dist/troika-three-text.esm.js' },
      { find: /^troika-three-utils$/, replacement: 'troika-three-utils/dist/troika-three-utils.esm.js' },
    ],
  },
  test: {
    // These packages publish ESM as .js without declaring type: module.
    server: { deps: { inline: ['troika-three-text', 'troika-three-utils'] } },
    include: ['packages/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/results/**', '**/reports/**'],
    testTimeout: 60_000,
  },
})
