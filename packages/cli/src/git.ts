import { execFileSync } from 'node:child_process'

/**
 * Asking git questions it is the only authority on — E4 (#29).
 *
 * **Why a subprocess at all**, when every other filesystem question in this repo is
 * answered with `node:fs`. "Is `.dogear/queue.json` ignored?" is not a question about the
 * bytes in `.gitignore`. The answer also depends on `.git/info/exclude`, on the user's
 * `core.excludesFile`, on every `.gitignore` between the root and the file, and on
 * negation rules with precedence that runs bottom-up within a file but top-down across
 * them. Reimplementing that would be a second, worse gitignore engine whose bugs surface
 * as a queue quietly getting committed. git is right there and it is definitive.
 *
 * This is the CLI's only subprocess, and it is reachable **only from `dogear init`** — a
 * command a human typed and is waiting on. `dogear hook` runs on every prompt under a 2s
 * budget (../test-built/hook.test.ts) and must never reach this file; ./init.ts's dynamic
 * `import()` of ./scaffold.js is what guarantees that, and this module is one more reason
 * that deferral is not decorative.
 *
 * **`undefined` is a real answer here, and the callers must treat it as one.** git may be
 * absent from `PATH`, may be a `.cmd` shim `execFileSync` cannot exec, may fail with 128
 * inside a worktree whose `gitdir:` pointer no longer resolves. None of those is an error
 * worth failing an init over, and none of them may be silently read as "yes, ignored" —
 * the safe direction is to write the ignore rules anyway. See ./gitignore.ts.
 */

/**
 * Run git and report its exit status, or `undefined` if it could not be run at all.
 *
 * `stdio: 'ignore'` on all three: `ls-files --error-unmatch` writes to stderr on the
 * ordinary not-tracked path, and that text is a diagnostic for a human running git by hand,
 * not for someone running init. {@link ignored} reads stdout, so it spawns git itself.
 */
function status(root: string, args: readonly string[]): number | undefined {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
    return 0
  } catch (error) {
    // A non-zero exit arrives as an error carrying `status`; a git that could not be
    // spawned at all arrives as ENOENT, with `status` null. The two are different answers.
    const code = (error as { status?: unknown }).status
    return typeof code === 'number' ? code : undefined
  }
}

/**
 * Which of `paths` would git ignore? `undefined` when git could not answer.
 *
 * Each path is repository-relative and **forward-slashed**, which git accepts on every
 * platform — `cwd` is the repository root, so a Windows-style path would still work, but
 * the same string is also written into `.gitignore`, where forward slashes are the only
 * correct form.
 *
 * **Several paths, one process** (#87). The `.gitignore` step asks about the queue and the
 * config on every init, and a git process costs around 40ms on Windows, so the two
 * questions share one. That was worth doing for the test suite, which runs init hundreds of
 * times; for a user it is one process fewer.
 *
 * The paths go in on stdin, where git never reads one as a flag. The paths involved are
 * compile-time constants today, so nothing can start with a dash, and that stays true of a
 * caller this file has not met.
 */
export function ignored(
  root: string,
  paths: readonly string[],
): ReadonlySet<string> | undefined {
  // Nothing to ask, so no process to start.
  if (paths.length === 0) return new Set()

  try {
    // 0 = at least one path is ignored, and stdout lists which. `-z` separates the paths with
    // NULs in both directions rather than quoting them, so the names come back exactly as they
    // were given, and git accepts it only alongside `--stdin`: with the paths as arguments it
    // exits 128. stderr stays ignored for the reason {@link status} gives.
    const listed = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: root,
      input: paths.map((path) => `${path}\0`).join(''),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      encoding: 'utf8',
    })

    return new Set(listed.split('\0').filter((path) => path !== ''))
  } catch (error) {
    // 1 = none are ignored. 128 = fatal, and a git that could not be spawned has no status at
    // all: both are "git could not answer", which is not the same as "no".
    return (error as { status?: unknown }).status === 1 ? new Set() : undefined
  }
}

/** Would git ignore `path`? {@link ignored} for one path. */
export function isIgnored(root: string, path: string): boolean | undefined {
  return ignored(root, [path])?.has(path)
}

/**
 * Is `path` in the index? `undefined` when git could not answer.
 *
 * This is the question `.gitignore` cannot answer for itself: an ignore rule has no
 * effect on a file git is already tracking, so a repo that ran a dev server before it ran
 * `dogear init` keeps committing its queue no matter what init writes.
 */
export function isTracked(root: string, path: string): boolean | undefined {
  // `--error-unmatch` is what turns "no output" into an exit code: 0 tracked, 1 not.
  const code = status(root, ['ls-files', '--error-unmatch', '--', path])
  if (code === 0) return true
  if (code === 1) return false
  return undefined
}

/** What ./gitignore.ts needs from git, as a type, so a test can supply its own. */
export interface GitQueries {
  readonly ignored: (
    root: string,
    paths: readonly string[],
  ) => ReadonlySet<string> | undefined
  readonly isTracked: (root: string, path: string) => boolean | undefined
}

/** The real thing. Tests build a `GitQueries` by hand to reach the degraded path. */
export const git: GitQueries = { ignored, isTracked }
