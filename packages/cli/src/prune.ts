import { findGitRoot } from '@dogear/queue'

import type { Result } from './run.js'
import { prune as pruneTool } from './tools.js'

/**
 * `dogear prune` — D6's human surface over an operation that already shipped.
 *
 * `pruneQueue` and `dogear_prune` both landed with D1, so nothing here is a second
 * implementation: this file resolves a repo, calls the same `prune()` the MCP server calls,
 * and turns the result into an exit code. That is the brief's rule working in the direction
 * it is usually quoted in reverse — a capability that cannot be reached through MCP does not
 * ship, and this one could already, which is why the CLI is free to be a thin trigger.
 *
 * **The success text is the tool's, verbatim.** Not a CLI-shaped paraphrase: one operation
 * reporting two different counts in two different sentences is how the two surfaces start
 * disagreeing, and ./prune.test.ts pins the equality rather than a string literal.
 *
 * **Failure is where the two surfaces legitimately differ, and `tools.ts` says so.** Its
 * `pending` header notes that D6 "will want their own presentation of the same failure",
 * which is why `callTool`'s `try` lives in the MCP adapter rather than around the operation.
 * An MCP client wants `isError: true` with the message as text; a shell wants a non-zero exit
 * and bytes on stderr. `emit()` handles the routing — on a non-zero exit it sends `output` to
 * stderr — so failures here need no special casing beyond the exit code.
 *
 * **Exiting non-zero is deliberate, and the opposite of `hook()`.** A `UserPromptSubmit` hook
 * that exits non-zero is surfaced as a hook failure and exit 2 erases what the user typed, so
 * ./hook.ts swallows everything. Nothing constrains a command a human ran on purpose, and the
 * opposite need applies: someone who typed `dogear prune` and got no pruning deserves to know
 * the queue was unreadable rather than empty. Do not harmonise these two.
 */
export function prune(cwd: string): Result {
  // `cwd`, never `CLAUDE_PROJECT_DIR`. That variable exists because Claude Code spawns the
  // hook from the session's directory; a human typing this is standing where they mean.
  const gitRoot = findGitRoot(cwd)

  if (gitRoot === undefined) {
    return {
      output:
        `dogear: no git repository at or above ${cwd}. ` +
        'dogear prune resolves its queue from the git root, so it cannot run here.',
      exitCode: 1,
    }
  }

  try {
    // Exit 0 whether or not anything went. "Nothing to prune" is an answer — the queue is in
    // the state the user asked for — and a non-zero exit would make `dogear prune` unusable
    // in a `&&` chain for the common case.
    return { output: pruneTool(gitRoot).text, exitCode: 0 }
  } catch (error) {
    // A corrupt or future-versioned queue. `pruneQueue` reads *strictly* and throws rather
    // than writing back what it could not parse — that refusal is the feature, and this is
    // where it becomes something a shell can see.
    return { output: `dogear: ${messageOf(error)}`, exitCode: 1 }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
