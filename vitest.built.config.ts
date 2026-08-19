import { defineConfig } from 'vitest/config'

/**
 * Suites that spawn dogear's built binary, and therefore require `npm run build` first.
 *
 * The third config, for the same reason there is a second: `npm test` must stay
 * build-independent, because stop-verify.sh runs it on every turn that touches TypeScript.
 * A suite that shells out to `dist/cli.js` cannot live there.
 *
 * Separate from vitest.leak.config.ts rather than folded into it. That one is F2's
 * production-leak *gate* — it scans build output for a sentinel and answers one question.
 * This one is behavioural. Sharing a config would mean `check:leak` no longer means what
 * its name says.
 *
 * Selection is by directory, as with the other two: a package's test-built/ directory
 * belongs to this config, its src/ to the default one. No config needs an `exclude` to
 * stay out of another's way.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test-built/*.test.ts'],
    environment: 'node',
    // E5 (#30). The spawned binary inherits this process's environment, so pinning
    // `DOGEAR_HOME` here keeps `dogear init` in a subprocess off the real home directory too.
    setupFiles: ['./vitest.setup.ts'],
  },
})
