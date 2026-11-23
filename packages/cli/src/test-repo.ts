import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll } from 'vitest'

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
 *
 * **Repositories are copied from a template, not initialised one by one** (#87). Starting a
 * git process costs around 40ms on Windows, and `npm test` used to run `git init` 420 times,
 * which made it four times slower there than on Linux. Each test file now runs `git init` once
 * and copies the resulting `.git` for every repository after that, in a few milliseconds. The
 * copy is still a repository git itself created, so every question asked of it is answered by
 * a real git, which is the premise above.
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
  packages: undefined,
  apps: Object.freeze([]),
  agents: Object.freeze([]),
  cli: Object.freeze({
    dir: '',
    state: 'local',
    manager: 'npm',
    linker: 'node-modules',
    pnpmWorkspaceRoot: false,
  }),
})

/** Env keys {@link isolateGitConfig} overwrites, so the caller can put them back. */
const KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'] as const

/** Any path that cannot exist. git treats an unreadable config file as an empty one. */
const NOWHERE = join(tmpdir(), 'dogear-no-such-gitconfig')

/**
 * Point git at no configuration at all, returning the function that restores the
 * environment. Call in `beforeEach`, call the result in `afterEach`.
 */
export function isolateGitConfig(): () => void {
  const saved = KEYS.map((key) => [key, process.env[key]] as const)

  process.env.GIT_CONFIG_GLOBAL = NOWHERE
  process.env.GIT_CONFIG_SYSTEM = NOWHERE
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

/**
 * The repository every {@link createRepo} in this test file copies, made on first use.
 *
 * Per file rather than per run because vitest evaluates this module afresh for each test file,
 * and the `afterAll` below is registered on whichever file is importing it. That is the same
 * arrangement `vitest.setup.ts` uses for its own temp directory, and it costs one `git init`
 * per file that asks for a repository at all.
 */
let template: string | undefined

afterAll(() => {
  if (template !== undefined) removeRepo(template)
  template = undefined
})

/** A fresh temp directory with a real `.git` in it. The caller removes it. */
export function createRepo(prefix: string): string {
  template ??= createTemplate()

  const root = mkdtempSync(join(tmpdir(), prefix))
  cpSync(join(template, '.git'), join(root, '.git'), { recursive: true })
  return root
}

/**
 * Initialise the template with git seeing no configuration, whatever the calling test has set.
 *
 * Without that, the first `createRepo` in a file would decide what every later one gets. A
 * developer's `init.templateDir` can carry an `info/exclude` that ignores `.dogear`, and a
 * template made outside {@link isolateGitConfig} would hand that rule to the suites that
 * isolate precisely so it cannot reach them.
 */
function createTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), 'dogear-template-'))

  execFileSync('git', ['init', '-q'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: NOWHERE,
      GIT_CONFIG_SYSTEM: NOWHERE,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })

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
