import { hook } from './hook.js'
import { init } from './init.js'
import { mcp } from './mcp.js'
import { prune } from './prune.js'

/**
 * Argument handling for the `dogear` CLI, kept separate from the executable so it can
 * be tested without a subprocess. ./cli.ts is the thin bin wrapper that calls this and
 * exits; everything with a decision in it lives here.
 *
 * ./hook.ts imports `Result` back from here, which is a cycle only on paper — it is an
 * `import type`, so it erases at compile time and no module-loading order exists to get
 * wrong.
 */

/**
 * TODO(dogear): `init`, `hook`, `mcp` and `prune` are implemented. `status` is E5. Listing it
 * now is deliberate — an unknown command and an unimplemented one are different failures, and
 * the CLI should be able to say which.
 */
export const COMMANDS = ['init', 'hook', 'mcp', 'prune', 'status'] as const

export type Command = (typeof COMMANDS)[number]

export interface Result {
  /**
   * stdout. The empty string means *write nothing at all* — not a blank line. `dogear hook`
   * runs as a `UserPromptSubmit` hook, and Claude Code injects that hook's stdout verbatim
   * as context, so a stray newline is a stray turn of context on every prompt the user types.
   */
  readonly output: string
  readonly exitCode: number
  /**
   * stderr, written regardless of exit code.
   *
   * This exists because `dogear hook` has a case the other commands do not: something went
   * wrong, the developer should hear about it, and the exit code must still be 0 while
   * stdout stays empty — `UserPromptSubmit` reads a non-zero exit as a failure to surface
   * and exit code 2 as "erase what the user typed". stderr is the only channel that reaches
   * the developer without also reaching the model.
   */
  readonly diagnostic?: string
}

/**
 * The other kind of outcome: a command whose bytes cannot be produced synchronously, so it
 * takes over the streams itself and hands back only an exit code.
 *
 * **Two commands land here for two different reasons**, and the distinction is worth keeping
 * straight because they behave nothing alike on stdout:
 *
 * - `dogear mcp` **owns the streams for its lifetime.** It frames JSON-RPC on stdin and stdout
 *   until its client disconnects, so a single stray byte desynchronises the client's parser and
 *   the server appears to hang. There is nothing for `emit()` to write — not even an empty
 *   string — and representing that as a `Result` with `output: ''` would be a lie that ./cli.ts
 *   could not tell apart from `dogear hook` on an empty queue.
 * - `dogear init` **produces ordinary bytes**, but reaches its implementation through a dynamic
 *   `import()` — the same deferral ./mcp.ts uses, for the same reason: `dogear hook` runs on
 *   every prompt the user types and must not pay to load code it never calls. Its bytes still go
 *   through `emit()` and `write()`; the promise is the import, not the work.
 *
 * What they share, and all this type claims, is that `run()` cannot hand ./cli.ts bytes to
 * write. Widening the *outcome* rather than making `run()` async keeps every argv decision in
 * this file, which is the whole reason ./cli.ts is short.
 */
export interface Async {
  /** Owns the streams until it finishes, resolving with the process exit code. */
  readonly run: () => Promise<number>
}

export type Outcome = Result | Async

export function isAsync(outcome: Outcome): outcome is Async {
  return 'run' in outcome
}

export function usage(): string {
  return [
    'dogear — point at an element, comment on it, hand it to your agent',
    '',
    'Usage: dogear <command>',
    '',
    'Commands:',
    // Deliberately not "config, gitignore, agent wiring", which is what init will do once
    // E2–E4 land and is not what it does today. The footer below now advertises init as
    // implemented, so the description has to be true of the command as shipped — and this
    // wording stays true as each later step is added, rather than needing an edit per epic.
    '  init     Set this repo up for dogear (safe to re-run)',
    '  hook     Emit UserPromptSubmit JSON (your agent runs this, not you)',
    '  mcp      Run the MCP server over stdio',
    '  prune    Drop resolved items from the queue',
    '  status   What is running and what is pending, across all repos',
    '',
    'Only `init`, `hook`, `mcp` and `prune` are implemented. See https://github.com/Alphyn44/dogear/milestones',
  ].join('\n')
}

export function run(argv: readonly string[]): Outcome {
  const [command] = argv

  if (command === undefined || command === '--help' || command === '-h') {
    return { output: usage(), exitCode: 0 }
  }

  if (!isCommand(command)) {
    return { output: `dogear: unknown command '${command}'\n\n${usage()}`, exitCode: 1 }
  }

  // `cwd`, never `CLAUDE_PROJECT_DIR`, and for the same reason as `prune` below: that variable
  // exists because Claude Code spawns the hook from the session's directory, and a human typing
  // `dogear init` is standing in the repo they mean. Not covered by a `run(['init'])` test that
  // gets as far as running anything — ./init.test.ts drives init() against temp roots, and
  // ./run.test.ts asserts only that the dispatch produces an Async without awaiting it.
  if (command === 'init') return init(process.cwd())

  // Dispatched before the unimplemented fallthrough, and given the environment here rather
  // than reading it inside hook() so that the only code touching process globals is this
  // file and ./cli.ts.
  if (command === 'hook') return hook(process.env, process.cwd())

  // `cwd` rather than CLAUDE_PROJECT_DIR: the MCP server is spawned by whichever client is
  // running it, and only Claude Code sets that variable. Where the client spawns from is the
  // one thing every client tells us.
  if (command === 'mcp') return mcp(process.cwd())

  // Not covered by a `run(['prune'])` test, and that is deliberate rather than an oversight.
  // This line reads `process.cwd()` directly — the same design that keeps ./cli.ts three
  // statements long — so calling it under vitest would prune *this repo's* queue and silently
  // delete the developer's resolved annotations on every `npm test`. The alternatives are
  // worse than the gap: `process.chdir()` is global mutable state shared by every test in the
  // worker, and threading a cwd parameter through `run()` would put argv handling and
  // environment plumbing back in the same function. ./prune.test.ts drives `prune()` against
  // temp git roots instead, and ./run.test.ts pins the command out of the unimplemented table.
  if (command === 'prune') return prune(process.cwd())

  return {
    output: `dogear: '${command}' is recognised but not implemented yet`,
    exitCode: 1,
  }
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value)
}
