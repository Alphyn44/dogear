import { findGitRoot, pendingOnly, queuePathFor, tryReadQueue } from '@dogear/queue'

import { formatQueue } from './format.js'
import type { Result } from './run.js'
import { findStale } from './stale.js'

/**
 * `dogear hook` — the `UserPromptSubmit` adapter for Claude Code.
 *
 * A3's crude proof of the disk→agent half. It is knowingly a capability that exists only
 * behind one agent's hook, which is a rule the brief otherwise forbids; D1's MCP server and
 * D3's rebuild restore it. What A3 buys is the two failure modes M0 exists to find — path
 * resolution and hook registration — surfaced now rather than inside D3.
 *
 * Four properties of Claude Code's hook contract shape this file, and every one of them is
 * a constraint rather than a preference:
 *
 * - **Exit code 2 blocks the prompt *and erases what the user typed.*** So this never exits
 *   2, and, since a thrown error would exit 1 with a stack trace injected into someone's
 *   session, it never throws either. Every failure path returns exit 0 and no context.
 * - **Plain stdout is injected as context** for this event, in addition to the structured
 *   JSON. "Emit nothing" therefore means writing zero bytes to stdout — not writing JSON
 *   with the context field omitted, and not writing a bare newline.
 * - **Diagnostics go to stderr**, which is not injected and is surfaced only in debug mode.
 *   That is the only channel here that can talk to the developer without also talking to
 *   the model.
 * - **`CLAUDE_PROJECT_DIR` is set**, which locates the repo without depending on `cwd` —
 *   the hook's working directory is the session's, and a user who started Claude Code in a
 *   subdirectory would otherwise get a different answer than the dev server did.
 *
 * `suppressOutput: true` keeps the block out of the transcript. It still reaches the model;
 * it just does not appear above every prompt the user types, which at one prompt per turn
 * is the difference between a feature and a nuisance.
 */

/** The event this adapter serves. Claude Code rejects a mismatched name. */
const HOOK_EVENT = 'UserPromptSubmit'

export interface HookEnv {
  readonly CLAUDE_PROJECT_DIR?: string | undefined
}

/**
 * Build the hook's response.
 *
 * `cwd` is injected rather than read so the tests can drive it; in production `run()` passes
 * `process.cwd()`. The fallback matters more than it looks — a hook invoked by something
 * other than Claude Code (a developer running `dogear hook` by hand to see what it emits)
 * has no `CLAUDE_PROJECT_DIR`, and falling back to the working directory makes that work
 * instead of silently producing nothing.
 */
export function hook(env: HookEnv, cwd: string): Result {
  const startDir = env.CLAUDE_PROJECT_DIR ?? cwd

  // Walk up for `.git` rather than trusting the start directory. CLAUDE_PROJECT_DIR is
  // wherever the session was opened, which in a monorepo is frequently a package
  // subdirectory — and the queue lives at the git root, because one repo is one queue.
  const gitRoot = findGitRoot(startDir)
  if (gitRoot === undefined) {
    return {
      output: '',
      exitCode: 0,
      diagnostic: `dogear: no git repository at or above ${startDir}; nothing to read`,
    }
  }

  const queuePath = queuePathFor(gitRoot)
  // The TOLERANT reader. The hook only ever reads, so it may swallow a corrupt file — and
  // must, since it cannot exit non-zero. A writer would use `readQueue` instead; see
  // `@dogear/queue`'s header for why that distinction is load-bearing.
  const queue = tryReadQueue(queuePath)
  if (!queue.ok) {
    // The queue is there and unreadable. Say so on stderr and inject nothing: a corrupt
    // file is exactly when the user needs a hint, and exactly when the model must not be
    // handed whatever bytes were in it.
    return { output: '', exitCode: 0, diagnostic: `dogear: ${queue.reason}` }
  }

  // Staleness is computed against the working tree on every prompt, never cached and never
  // stored — the files under these annotations are exactly what the user is changing between
  // one prompt and the next. `findStale` reads only the files the queue names, deduplicated,
  // which is why this stays inside the hook's budget.
  const pending = pendingOnly(queue.items)
  const context = formatQueue(pending, { stale: findStale(pending, gitRoot) })
  if (context === '') return { output: '', exitCode: 0 }

  return {
    output: JSON.stringify({
      hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: context },
      suppressOutput: true,
    }),
    exitCode: 0,
  }
}
