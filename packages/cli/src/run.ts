import { hook } from './hook.js'
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
 * TODO(dogear): `hook`, `mcp` and `prune` are implemented. `init` is E1 and `status` is E5.
 * Listing them now is deliberate — an unknown command and an unimplemented one are different
 * failures, and the CLI should be able to say which.
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
 * The other kind of outcome: a command that owns the streams instead of producing bytes.
 *
 * `dogear mcp` runs until its client disconnects and frames JSON-RPC on stdin and stdout for
 * that whole time, so a single stray byte on stdout desynchronises the client's parser and
 * the server appears to hang. There is therefore nothing for `emit()` to write — not even an
 * empty string — and representing that as a `Result` with `output: ''` would be a lie that
 * ./cli.ts could not tell apart from `dogear hook` on an empty queue.
 *
 * Widening the *outcome* rather than making `run()` async keeps every argv decision in this
 * file, which is the whole reason ./cli.ts is three statements long.
 */
export interface Serve {
  /** Runs until the client disconnects, resolving with the process exit code. */
  readonly serve: () => Promise<number>
}

export type Outcome = Result | Serve

export function isServe(outcome: Outcome): outcome is Serve {
  return 'serve' in outcome
}

export function usage(): string {
  return [
    'dogear — point at an element, comment on it, hand it to your agent',
    '',
    'Usage: dogear <command>',
    '',
    'Commands:',
    '  init     Scaffold this repo: config, gitignore, agent wiring',
    '  hook     Emit UserPromptSubmit JSON (your agent runs this, not you)',
    '  mcp      Run the MCP server over stdio',
    '  prune    Drop resolved items from the queue',
    '  status   What is running and what is pending, across all repos',
    '',
    'Only `hook`, `mcp` and `prune` are implemented. See https://github.com/Alphyn44/dogear/milestones',
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
