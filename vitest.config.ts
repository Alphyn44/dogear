import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // @dogear/core's exports map deliberately sends BOTH `production` and the
    // catch-all `default` condition to dist/noop.js, so that any resolver whose
    // conditions we don't recognise fails safe (F1, layer 3). Node itself sets no
    // `development` condition — Vite does, during serve — which means a plain
    // `import '@dogear/core'` from a test would land on the noop and cheerfully
    // assert nothing. Naming the condition here is what keeps tests pointed at the
    // real module.
    conditions: ['development'],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
})
