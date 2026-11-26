import { defineConfig } from 'tsup'

export default defineConfig({
  // The loader is its own entry so that evaluating `next.config` never loads Oxc's native
  // binding: `index.js` names `loader.js` by path and never imports it.
  entry: ['src/index.ts', 'src/loader.ts'],
  // Each entry self-contained. With splitting on, tsup hoisted what both entries share into one
  // chunk that imported `oxc-parser` at its top level, and `index.js` imported that chunk. The
  // transform being the subpath `dogear-host/stamp` is the real fix; this keeps a future shared
  // import from reopening it. test-built/next-dev.test.ts asserts `index.js` imports no parser.
  splitting: false,
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,

  // See packages/core/tsup.config.ts: tsup's bundled rollup-plugin-dts cannot run
  // against TypeScript 7. Declarations come from `tsc --emitDeclarationOnly`.
  dts: false,
  // next is a peerDependency and is only ever imported for types today. Listed anyway, so a
  // value import added later cannot quietly bundle a second copy of Next into the wrapper.
  external: ['next'],
  // Both private packages are inlined, for the reason packages/vite/tsup.config.ts gives:
  // neither is published, so a consumer could never install them.
  noExternal: ['dogear-queue', 'dogear-host'],
})
