import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll } from 'vitest'

/**
 * Point `DOGEAR_HOME` somewhere disposable for every suite — E5 (#30).
 *
 * **This is a floor, not the isolation itself.** Suites that care which registry they are
 * writing to still call `isolateRegistry()` from `packages/cli/src/test-repo.ts`, which gives
 * them a fresh directory per test and hands back the path so assertions can name it. What
 * this file removes is the *default*: without it, a suite that reaches `dogear init` without
 * thinking about the registry writes into the developer's real `~/.dogear/projects.json`, and
 * into CI's.
 *
 * That failure is worth a global rather than a convention because of how it presents. Nothing
 * goes red — the suite passes exactly as it did before — and the only symptom is a file in the
 * user's home directory slowly filling with entries for temp directories that no longer exist.
 * `packages/cli/src/init.test.ts` did precisely this, and it was caught by opening the file
 * rather than by a test.
 *
 * One directory per worker process, not per test: `setupFiles` runs once per test file, and
 * anything needing finer isolation than that has `isolateRegistry()`.
 */
const home = mkdtempSync(join(tmpdir(), 'dogear-vitest-home-'))

process.env.DOGEAR_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})
