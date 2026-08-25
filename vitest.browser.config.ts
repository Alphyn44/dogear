import { defineConfig } from 'vitest/config'

/**
 * H3 (#55). The sixth config, and the only one whose subject is the *browser*.
 *
 * Every other suite tests one half of dogear against a stub of the other. The transform has
 * fixtures, the endpoint has a real server, the queue has a tolerance suite, the DOM suites
 * have happy-dom — which has no layout engine, so `getBoundingClientRect` returns zeros there
 * and every piece of geometry is tested as a pure function instead. What none of them can
 * reach is the seam: a real keyboard-modified pointer event, in a real engine, arriving at a
 * real dev server, and a file on disk afterwards. That is the product's central claim, and
 * until this it rested entirely on a person having clicked.
 *
 * **Deliberately not part of `npm run verify`**, for the reason vitest.packed.config.ts gives
 * and one of its own. Playwright ships no browser binaries — they are a separate download —
 * and verify.yml is what release.yml gates on, so a release must not be able to fail because
 * a browser CDN was slow. It runs as its own ci.yml job, alongside `packed`, `managers`,
 * `versions` and `dependencies`, which are out of those nine steps on exactly this argument.
 *
 * Needs `npm run build` first, like vitest.built.config.ts and vitest.packed.config.ts: the
 * fixture consumes `dogear-vite` through its exports map and the plugin serves `dogear-core`'s
 * built `dist/client.js`. `requireBuild()` in ./test-browser/fixture.ts fails with the command
 * to run rather than letting the stub bundle surface as "no annotation arrived".
 *
 * Selection is by directory, as with the other five, so no config needs an `exclude` to stay
 * out of another's way. `test-browser/*.test.ts` is non-recursive for the same reason
 * `test-packed/*.test.ts` is — ./test-browser/app/ holds the fixture's own source, and a
 * recursive pattern is how a fixture directory ends up being collected as a suite.
 */
export default defineConfig({
  test: {
    include: ['test-browser/*.test.ts'],
    environment: 'node',
    // The fixture starts a real dev server, and the plugin registers itself in
    // ~/.dogear/projects.json on the httpServer `listening` event. vitest.setup.ts pins
    // DOGEAR_HOME at a temp directory, which the spawned vite inherits — without it every run
    // quietly fills the developer's real registry with temp directories and nothing goes red.
    // See CLAUDE.md's registry notes for why that failure is invisible.
    setupFiles: ['./vitest.setup.ts'],
    // A browser launch plus a vite cold start with dependency pre-bundling, once per describe
    // block. The cases themselves are input and a poll of one small file.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // One browser is shared by the file, and the two blocks each hold a dev server on a port
    // they claimed. Running them concurrently would contend for both.
    fileParallelism: false,
  },
})
