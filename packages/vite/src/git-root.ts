import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Finding the repository root, which is where the queue lives.
 *
 * The brief's rule: the queue resolves from the git root, NOT the Vite root. One repo is
 * one queue is one agent session. A monorepo with three dev servers must not produce three
 * queues, because the reader on the other end would have no way to know which to open.
 *
 * This is the piece D1's MCP server needs too — it performs the same walk, but starting
 * from `cwd` rather than from a Vite root. When D1 lands, move this file rather than
 * writing a second copy.
 */

/**
 * Walk up from `startDir` looking for `.git`, returning the directory that contains it.
 *
 * `.git` is checked for existence rather than for being a directory, and that distinction
 * is load-bearing: in a git worktree or a submodule, `.git` is a *file* containing a
 * `gitdir:` pointer. Testing `isDirectory()` would walk straight past those and either find
 * an unrelated parent repository or nothing at all — a silent wrong answer, which is the
 * worst kind here, since it would put the queue somewhere the reader never looks.
 *
 * Returns `undefined` outside a repository. The caller decides what that means; this
 * function does not guess a fallback, because every available fallback (the Vite root, the
 * cwd) is a location some other process would fail to find.
 */
export function findGitRoot(startDir: string): string | undefined {
  let current = resolve(startDir)

  // dirname('/') === '/' and dirname('C:\\') === 'C:\\', so the fixed point is the
  // filesystem root on both platforms. Comparing against a hardcoded '/' would loop
  // forever on Windows.
  for (;;) {
    if (existsSync(join(current, '.git'))) return current

    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
