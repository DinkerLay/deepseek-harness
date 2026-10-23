import { defineConfig } from 'tsdown'

/** Shared chunks preserve class identity across the plugin and adapter entries. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/standalone.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  // Remove stale hashed chunks without deleting TypeScript build inputs.
  clean: ['lib/*.js'],
})
