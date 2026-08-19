import { findGitRoot } from '@dogear/queue'

import type { Outcome } from './run.js'

/**
 * `dogear mcp` — the command adapter for the MCP server.
 *
 * Two things happen here and nothing else: the repo is resolved, and the SDK-bearing module
 * is handed back as a continuation rather than imported.
 *
 * **The import in ./server.js is dynamic on purpose.** `dogear hook` runs on every prompt
 * the user types, inside a 10s hook timeout with a 2s budget asserted in
 * ../test-built/hook.test.ts. Loading `@modelcontextprotocol/sdk` on the way to a command
 * that does not use it would spend that budget on nothing. This file therefore imports no
 * SDK at all, and ./server.js is reached only when someone actually runs `dogear mcp`.
 *
 * **The failure mode is the opposite of the hook's, and that is intentional.** `hook()`
 * exits 0 and says nothing when there is no git repository, because `UserPromptSubmit` reads
 * a non-zero exit as a failure to surface and exit 2 as "erase what the user typed". A
 * server has neither constraint, and the opposite need: a client that cannot start its
 * server should say so loudly. A dogear that started anyway and answered "no annotations"
 * forever would look like an empty queue rather than a misconfiguration — a much worse bug
 * than a red entry in `/mcp`. Do not "harmonise" these two.
 */
export function mcp(cwd: string): Outcome {
  // Walk up from `cwd`, exactly as the plugin walks up from its Vite root. One repo is one
  // queue, so a client that spawns the server in a package subdirectory must still find the
  // file the dev server wrote at the root.
  const gitRoot = findGitRoot(cwd)

  if (gitRoot === undefined) {
    return {
      output:
        `dogear: no git repository at or above ${cwd}. ` +
        'dogear mcp resolves its queue from the git root, so it cannot start here.',
      exitCode: 1,
    }
  }

  // An `Async` outcome, and the strictest kind: from here the transport owns stdout, so
  // unlike `dogear init` — the other command in that variant — nothing may ever be written
  // through `emit()`. See ./run.ts's `Async` for the distinction.
  return { run: async () => (await import('./server.js')).serve(gitRoot) }
}
