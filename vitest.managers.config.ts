import { defineConfig } from 'vitest/config'

/**
 * H6 (#58). The fifth config, and the only one whose subject is the *package manager* rather
 * than the code.
 *
 * Everything `dogear init` writes — the MCP registration and Claude Code's prompt hook — points
 * at `node_modules/dogear-cli/dist/cli.js`. That path is repo-relative and committed on purpose,
 * so it has to resolve for whoever clones rather than only on the machine that ran init. Which
 * means it has to survive whatever tool they install with, and H1's suite only ever proved it
 * under npm. The suite under ./test-packed/managers installs the same tarballs with pnpm and
 * with Yarn, and asserts that the committed path still resolves — and, for Yarn's PnP linker,
 * that it demonstrably does not.
 *
 * **A config of its own rather than more cases in vitest.packed.config.ts.** The two are the
 * same machinery pointed at different questions, and separating them is what lets CI run H1's
 * npm leg across three platforms while these run across two: a manager's layout is the same on
 * macOS as on Linux, and each leg is a full install — the slowest operation in the repository.
 *
 * Selection is by directory, as with the other four, so no config needs an `exclude` to stay out
 * of another's way. `test-packed/*.test.ts` is not recursive, which is what keeps H1's suite
 * from picking these up.
 *
 * **Deliberately not part of `npm run verify`**, for the reason vitest.packed.config.ts gives:
 * the scratch installs reach the registry, and verify.yml is what release.yml gates on.
 *
 * Needs `npm run build` first — `npm pack` packs what is on disk — and needs the `pnpm` and
 * `@yarnpkg/cli-dist` devDependencies, which is how the managers are reached without a `.cmd`
 * shim on Windows. See `managerCommand` in ./test-packed/fixture.ts.
 */
export default defineConfig({
  test: {
    include: ['test-packed/managers/*.test.ts'],
    environment: 'node',
    // These suites reach `dogear init`. vitest.setup.ts pins DOGEAR_HOME at a temp directory,
    // without which init in a subprocess writes into the runner's real ~/.dogear and nothing
    // goes red — see CLAUDE.md's registry notes for why that failure is invisible.
    setupFiles: ['./vitest.setup.ts'],
    // One pack plus one full install per leg, in `beforeAll`. Three legs run in the same file
    // rather than concurrently: they contend for the same CPU and the same package caches, so
    // running them at once makes each one slower without finishing any sooner.
    hookTimeout: 900_000,
    testTimeout: 120_000,
  },
})
