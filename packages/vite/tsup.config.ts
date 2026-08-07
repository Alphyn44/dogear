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
  // vite is a peerDependency; bundling it into the plugin would ship a second copy
  // of Vite into the consumer's dev server.
  external: ['vite'],
})
