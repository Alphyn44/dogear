import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries, not one: the exports map routes `production`/`default` at noop.js,
  // so it has to be emitted as a real file alongside index.js.
  entry: ['src/index.ts', 'src/noop.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  clean: true,
  sourcemap: true,

  // Declarations come from `tsc --emitDeclarationOnly` (see tsconfig.build.json and
  // the package's `build` script), NOT from tsup.
  //
  // tsup's dts path bundles rollup-plugin-dts, which is compiled against the
  // TypeScript 5.7 compiler API and reaches for internals the TypeScript 7 native
  // port does not expose — it dies on `useCaseSensitiveFileNames` before emitting
  // anything. JS emit is esbuild and is completely unaffected, which is why only
  // this one flag had to move.
  dts: false,
})
