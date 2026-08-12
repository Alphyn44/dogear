import { defineConfig } from 'tsup'

export default defineConfig({
  // Three entries, and each is a different consumer:
  //
  // - index.ts  — the library surface, what the exports map's `development` condition points
  //               at, and what a consumer would import by name.
  // - noop.ts   — emitted as a real file because `production`/`default` route to it.
  // - client.ts — the dev-server client, served verbatim by @dogear/vite at
  //               `<endpoint>/client.js`. Deliberately absent from the exports map: it
  //               self-starts on import and carries the sentinel, neither of which has any
  //               business being reachable by `import '@dogear/core/…'`.
  entry: ['src/index.ts', 'src/noop.ts', 'src/client.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  clean: true,
  sourcemap: true,

  // Each entry must be SELF-CONTAINED, and this is not a size preference.
  //
  // With three entries sharing modules, tsup's default is to hoist the common code into a
  // `chunk-XXXX.js` and have each entry import it. `client.js` is served over HTTP by
  // @dogear/vite as a single file at `<endpoint>/client.js` — so a sibling import would send
  // the browser to `<endpoint>/chunk-XXXX.js`, which the endpoint answers with a 404, and the
  // overlay would never load. Nothing in `npm test` can see that: every suite that touches
  // the route serves a synthetic bundle. `test-built/self-contained.test.ts` is the guard.
  //
  // The cost is that the shared overlay code is emitted into index.js and client.js both.
  // They are never loaded together — one is the library entry, the other is the dev client.
  splitting: false,

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
