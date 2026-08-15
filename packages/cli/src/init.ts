import { findGitRoot } from '@dogear/queue'

import { write } from './emit.js'
import type { Outcome } from './run.js'

/**
 * `dogear init` — the command adapter. E1 (#26).
 *
 * Structurally the twin of ./mcp.ts: resolve the repository here, hand the implementation
 * back as a continuation rather than importing it. ./scaffold.ts holds everything that
 * actually touches the repo.
 *
 * **The refusal is synchronous, and that is the second acceptance criterion.** A `dogear init`
 * outside a git repository has nowhere correct to put anything — the queue is
 * `<git-root>/.dogear/queue.json`, and every other reader in the system walks up for `.git` to
 * find it. Guessing `cwd` would produce a directory the dev server and the MCP server would
 * both fail to find, which is worse than refusing: the user would get a successful init and an
 * empty queue forever. Returning a `Result` rather than rejecting inside `run()` also keeps
 * this path free of the dynamic import, so it stays assertable in the fast suite.
 *
 * **The exit code is non-zero, unlike `dogear hook`'s.** The hook swallows a missing repo and
 * exits 0 because `UserPromptSubmit` reads a non-zero exit as a hook failure and exit 2 as
 * "erase what the user typed". Nothing constrains a command a human ran on purpose, and the
 * opposite need applies — someone who typed `dogear init` and got nothing deserves to know
 * why. Same reasoning as ./prune.ts and ./mcp.ts; do not harmonise the three with the hook.
 *
 * **The dynamic import is prophylactic rather than load-bearing today.** ./scaffold.ts imports
 * `node:fs` and `node:path` and nothing else, so eagerly importing it would cost `dogear hook`
 * almost nothing right now. It is deferred anyway because E2's detection and E3's config
 * merging are exactly the kind of code that grows, the only alarm is the 2s budget in
 * ../test-built/hook.test.ts, and by the time that fires the seam is expensive to add. It also
 * means the CLI keeps exactly one shape for "command whose implementation loads on demand",
 * which tsup's `splitting: true` already exists to serve.
 */
export function init(cwd: string): Outcome {
  // `cwd`, never `CLAUDE_PROJECT_DIR`. That variable exists because Claude Code spawns the
  // hook from the session's directory; a human typing this is standing where they mean.
  const gitRoot = findGitRoot(cwd)

  if (gitRoot === undefined) {
    return {
      output:
        `dogear: no git repository at or above ${cwd}. ` +
        'dogear init sets up .dogear/ at the git root, so it cannot run here.',
      exitCode: 1,
    }
  }

  // An `Async` outcome of the byte-producing kind — the opposite of `dogear mcp`, which enters
  // this variant because it must write *nothing*. `write()` is shared with ./cli.ts so both
  // paths obey the rule that an empty output means zero bytes rather than a blank line.
  return { run: async () => write((await import('./scaffold.js')).scaffold(gitRoot)) }
}
