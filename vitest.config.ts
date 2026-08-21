import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // dogear-core's exports map deliberately sends BOTH `production` and the
    // catch-all `default` condition to dist/noop.js, so that any resolver whose
    // conditions we don't recognise fails safe (F1, layer 3). Node itself sets no
    // `development` condition — Vite does, during serve — which means a plain
    // `import 'dogear-core'` from a test would land on the noop and cheerfully
    // assert nothing. Naming the condition here is what keeps tests pointed at the
    // real module.
    conditions: ['development'],
  },
  test: {
    // scripts/*.test.ts covers the leak scanner's own unit tests, which are hermetic
    // (synthetic temp fixtures) and so belong in the fast suite. The gate that reads real
    // build output lives in scripts/gate/ and runs under vitest.leak.config.ts instead —
    // selecting by directory keeps the two configs from needing exclude rules.
    include: ['packages/*/src/**/*.test.ts', 'scripts/*.test.ts'],
    environment: 'node',
    // E5 (#30). Keeps `DOGEAR_HOME` off the developer's real home directory by default —
    // see ./vitest.setup.ts for why this is a global rather than a convention.
    setupFiles: ['./vitest.setup.ts'],
  },
})
