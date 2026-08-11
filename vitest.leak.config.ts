import { defineConfig } from 'vitest/config'

/**
 * The production leak gate (F2), kept in its own config because it is the one suite that
 * requires a build first. `npm test` must stay build-independent — stop-verify.sh runs it
 * on every turn that touches TypeScript.
 *
 * Selection is by directory, not filename: scripts/gate/* here, scripts/*.test.ts in the
 * default config. That way neither config needs an `exclude` to avoid the other.
 */
export default defineConfig({
  test: {
    include: ['scripts/gate/*.test.ts'],
    environment: 'node',
  },
})
