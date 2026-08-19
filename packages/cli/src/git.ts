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
 * `stdio: 'ignore'` on all three: `check-ignore -q` is silent by contract but
 * `ls-files --error-unmatch` writes to stderr on the ordinary not-tracked path, and that
 * text is a diagnostic for a human running git by hand, not for someone running init.
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
 * Would git ignore `path`? `undefined` when git could not answer.
 *
 * `path` is repository-relative and **forward-slashed**, which git accepts on every
 * platform — `cwd` is the repository root, so a Windows-style path would still work, but
 * the same string is also written into `.gitignore`, where forward slashes are the only
 * correct form.
 *
 * `--` separates it from the flags. The paths involved are compile-time constants today,
 * so nothing can start with a dash; the separator is there so that stays true of a caller
 * this file has not met.
 */
export function isIgnored(root: string, path: string): boolean | undefined {
  // 0 = at least one path is ignored, 1 = none are, 128 = fatal. `-q` suppresses the
  // listing, which we would only throw away.
  const code = status(root, ['check-ignore', '-q', '--', path])
  if (code === 0) return true
  if (code === 1) return false
  return undefined
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
  readonly isIgnored: (root: string, path: string) => boolean | undefined
  readonly isTracked: (root: string, path: string) => boolean | undefined
}

/** The real thing. Tests build a `GitQueries` by hand to reach the degraded path. */
export const git: GitQueries = { isIgnored, isTracked }
