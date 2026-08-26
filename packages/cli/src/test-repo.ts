import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Detection } from './detect.js'

/**
 * A real git repository in a temp directory, for the suites that need one — E4 (#29).
 *
 * **Test-only, and never reachable from `dist/`.** tsup bundles from `src/cli.ts` alone, so
 * a module nothing in that graph imports is not in the shipped binary. It lives beside the
 * code rather than in a `test/` directory because `npm test` collects
 * `packages/*&#47;src/**&#47;*.test.ts` and the helper has to sit where those files can reach it.
 *
 * **Why a real repository rather than a stub.** ./gitignore.ts asks git whether a path is
 * ignored, on the grounds that git is the only thing that knows. A test that stubbed the
 * answer would verify the branch and none of the premise — it would still pass if
 * `check-ignore`'s exit codes were backwards, which is the one thing worth pinning here.
 * The injected-`GitQueries` seam exists for the *degraded* path, where there is no real
 * behaviour left to exercise.
 *
 * **The config isolation is not optional.** `check-ignore` consults `core.excludesFile` and
 * the system config, so a developer whose own `~/.gitignore` happens to mention `.dogear`
 * would get different results from the same test — passing here, failing in CI, or worse,
 * the reverse. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are pointed at a path that does
 * not exist, which git reads as an empty config, and `GIT_CONFIG_NOSYSTEM` covers the same
 * ground for a git older than 2.32.
 */

/**
 * What to hand `Step.plan`'s second parameter when the step under test ignores it — E2 (#27).
 *
 * E4's three steps ignore it entirely. E3's (#28) three read it, and they build their own —
 * in their own suites, where the shape is the point. A shared empty value is better than
 * `detect(root)` at each call site, which would walk a temp directory to produce a result the
 * assertion does not depend on, and better than a cast, which would keep compiling after
 * `Detection` grows a field. It is spelled out in full for that last reason: every new field
 * has to be answered here, which is how a suite that should have been updated fails to compile
 * instead of silently testing the old shape.
 */
export const NO_DETECTION: Detection = Object.freeze({
  workspace: 'single',
  manager: 'npm',
  linker: 'node-modules',
  packages: undefined,
  apps: Object.freeze([]),
  agents: Object.freeze([]),
  cli: 'local',
})

/** Env keys {@link isolateGitConfig} overwrites, so the caller can put them back. */
const KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'] as const

/**
 * Point git at no configuration at all, returning the function that restores the
 * environment. Call in `beforeEach`, call the result in `afterEach`.
 */
export function isolateGitConfig(): () => void {
  const saved = KEYS.map((key) => [key, process.env[key]] as const)

  // Any path that cannot exist. git treats an unreadable config file as an empty one.
  const nowhere = join(tmpdir(), 'dogear-no-such-gitconfig')
  process.env.GIT_CONFIG_GLOBAL = nowhere
  process.env.GIT_CONFIG_SYSTEM = nowhere
  process.env.GIT_CONFIG_NOSYSTEM = '1'

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * Point the machine-level registry at a temp directory, returning the function that restores
 * the environment. Call in `beforeEach`, call the result in `afterEach` — E5 (#30).
 *
 * **Every suite that reaches `dogear init`'s registry step needs this**, and the failure
 * without it is not a test failure: `scaffold()` would register each temp repository in the
 * developer's own `~/.dogear/projects.json`, and in CI's. The suites would pass while
 * silently filling a real file with entries for directories that no longer exist.
 *
 * The same shape as {@link isolateGitConfig}, and for the same reason — the environment is
 * worker-global, so it is saved and put back rather than set once.
 */
export function isolateRegistry(): { home: string; restore: () => void } {
  const saved = process.env.DOGEAR_HOME
  const home = mkdtempSync(join(tmpdir(), 'dogear-home-'))
  process.env.DOGEAR_HOME = home

  return {
    home,
    restore: () => {
      if (saved === undefined) delete process.env.DOGEAR_HOME
      else process.env.DOGEAR_HOME = saved

      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** A fresh temp directory with a real `.git` in it. The caller removes it. */
export function createRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  run(root, ['init', '-q'])
  return root
}

/** Stage a path, which is how the "already tracked" case gets built. */
export function trackFile(root: string, relativePath: string): void {
  run(root, ['add', '--', relativePath])
}

/** Remove a repository created by {@link createRepo}. */
export function removeRepo(root: string): void {
  // git writes object files read-only, which Windows enforces on unlink. Node's rm handles
  // that internally (it chmods and retries on EPERM), so `force` plus retries is enough
  // without walking the tree ourselves.
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}

function run(root: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
}
