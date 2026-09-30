import { defineConfig } from 'tsdown'

/** Builds the host entry and the plain-Node raster worker as separate published files. */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { 'raster-worker': 'lib/types/raster-worker.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // A plain Node child cannot read this tree from inside an ASAR archive, so the
    // worker entry carries every workspace module inlined; Sharp stays external.
    deps: { alwaysBundle: [/^@deepseek-ai\//u] },
  },
])
