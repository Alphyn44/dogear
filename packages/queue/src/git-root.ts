import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Finding the repository root, which is where the queue lives.
 *
 * The brief's rule: the queue resolves from the git root, NOT from `cwd` and not from
 * `CLAUDE_PROJECT_DIR`. One repo is one queue is one agent session. A monorepo with three
 * dev servers writes to one file, so every reader has to walk to the same place all three
 * writers walked to.
 *
 * Three callers, all of which must agree, which is why this lives in a shared package
 * rather than being copied per consumer:
 *
 * - The **plugin** walks from `config.root` — a Vite root that in a monorepo is routinely
 *   several levels below the repo, and that a hand-written `vite.config.ts` is under no
 *   obligation to hand us in canonical form.
 * - The **hook** walks from `CLAUDE_PROJECT_DIR`, which is wherever the session was opened.
 * - The **MCP server** walks from `cwd`, which is wherever the client spawned it.
 */

/**
 * Walk up from `startDir` looking for `.git`, returning the directory that contains it.
 *
 * `.git` is checked for existence rather than for being a directory, and that distinction
 * is load-bearing: in a git worktree or a submodule, `.git` is a *file* containing a
 * `gitdir:` pointer. Testing `isDirectory()` would walk straight past those and either find
 * an unrelated parent repository or nothing at all — a silent wrong answer, which is the
 * worst kind here, since it would send a reader looking for a queue in a directory nothing
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
