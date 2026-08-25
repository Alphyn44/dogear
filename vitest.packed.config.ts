import { defineConfig } from 'vitest/config'

/**
 * H1 (#53). The fourth config, and the only one whose subject is what npm *publishes*
 * rather than what this repository contains.
 *
 * Every cross-package resolution in this workspace goes through a symlink into `packages/*`,
 * where `dist/` already sits because `npm run build` put it there. So `files`, `exports` and
 * `bin` are never consulted by anything in `npm run verify` — a tarball shipping no `dist` at
 * all passes all nine steps. The suite under ./test-packed installs the real tarballs
 * somewhere npm has to obey the manifest instead.
 *
 * **Deliberately not part of `npm run verify`.** The scratch install reaches the registry for
 * magic-string, the MCP SDK and vite, and verify.yml is called by release.yml — a release must
 * not be able to fail because a registry was slow. CI runs this as its own job for the same
 * reason #65 gives for keeping an audit out of those nine steps.
 *
 * Needs `npm run build` first, like vitest.built.config.ts: `npm pack` packs what is on disk,
 * and none of the three packages has a prepack script that would build for it.
 *
 * Selection is by directory, as with the other three, so no config needs an `exclude` to stay
 * out of another's way.
 */
export default defineConfig({
  test: {
    include: ['test-packed/*.test.ts'],
    environment: 'node',
    // The suite reaches `dogear init`. vitest.setup.ts pins DOGEAR_HOME at a temp directory,
    // without which init in a subprocess writes into the runner's real ~/.dogear and nothing
    // goes red — see CLAUDE.md's registry notes for why that failure is invisible.
    setupFiles: ['./vitest.setup.ts'],
    // `npm pack` plus a full install from the registry dominates the run, and it happens once
    // for the file rather than once per case.
    hookTimeout: 600_000,
    testTimeout: 120_000,
  },
})
