import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
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
