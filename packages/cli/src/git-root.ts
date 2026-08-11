import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Finding the repository root, which is where the queue lives.
 *
 * The brief's rule: the queue resolves from the git root, NOT from `cwd` and not from
 * `CLAUDE_PROJECT_DIR`. One repo is one queue is one agent session. A monorepo with three
 * dev servers writes to one file, so the reader has to walk to the same place all three
 * writers walked to.
 *
 * **Why this is a copy of `packages/vite/src/git-root.ts` rather than an import.** The two
 * packages have no dependency edge, and the three ways to create one are all worse than a
 * fourteen-line duplicate: making the CLI depend on a Vite plugin it never runs, inverting
 * the edge so the plugin depends on the CLI, or adding a fourth workspace package to hold
 * fifty lines — which the brief argued against explicitly when it folded the hook into the
 * CLI. The same trade was made for the leak sentinel, and it is guarded the same way:
 * ./parity.test.ts imports both and fails if they ever disagree.
 *
 * D1's MCP server lives in this package and performs exactly this walk, so this file is the
 * one that survives. When D1 lands, delete the vite copy in favour of this one rather than
 * keeping both.
 */

/**
 * Walk up from `startDir` looking for `.git`, returning the directory that contains it.
 *
 * `.git` is checked for existence rather than for being a directory, and that distinction
 * is load-bearing: in a git worktree or a submodule, `.git` is a *file* containing a
 * `gitdir:` pointer. Testing `isDirectory()` would walk straight past those and either find
 * an unrelated parent repository or nothing at all — a silent wrong answer, which is the
 * worst kind here, since it would send the hook looking for a queue in a directory nothing
 * ever writes to.
 *
 * Returns `undefined` outside a repository. The caller decides what that means; this
 * function does not guess a fallback, because every available fallback is a location some
 * other process would fail to find.
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
