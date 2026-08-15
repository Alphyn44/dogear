import type { Result } from './run.js'

/**
 * Turning a {@link Result} into the exact bytes each stream receives.
 *
 * This exists as a function rather than as three `if`s in ./cli.ts because of what A4
 * asks for. "An empty queue emits no context" is a claim about *bytes on stdout*, and a
 * branch inside the executable can only be checked by spawning a process — which needs a
 * build, which `npm test` deliberately does not have. Returning the streams as values
 * makes the claim an equality assertion in the fast suite instead.
 *
 * The distinction that matters, and the reason an empty string is not the same as no
 * output: Claude Code injects a `UserPromptSubmit` hook's stdout **verbatim** as context.
 * A lone `\n` written for an empty queue is a lone `\n` prepended to every prompt the user
 * types, forever. So the empty case has to be zero bytes, not a blank line.
 */

export interface Emission {
  /** Written to stdout verbatim. Empty means *nothing at all*, not a blank line. */
  readonly stdout: string
  /** Written to stderr verbatim. Same rule. */
  readonly stderr: string
  readonly exitCode: number
}

/**
 * Route a result to its streams.
 *
 * Two rules, both inherited from the hook contract:
 *
 * - **Success goes to stdout, failure to stderr**, so a shell pipeline sees what it
 *   expects. The exit code decides, not the content.
 * - **A diagnostic always goes to stderr, whatever the exit code**, and comes first.
 *   `dogear hook` reports a broken queue while still exiting 0, because a non-zero exit
 *   from a `UserPromptSubmit` hook is surfaced to the user as a hook failure and exit
 *   code 2 rejects the prompt outright. stderr on a zero exit reaches the developer's
 *   debug log without reaching the model's context.
 */
export function emit(result: Result): Emission {
  const { output, exitCode, diagnostic } = result

  const outputLine = output === '' ? '' : `${output}\n`
  const diagnosticLine = diagnostic === undefined ? '' : `${diagnostic}\n`

  return {
    stdout: exitCode === 0 ? outputLine : '',
    stderr: exitCode === 0 ? diagnosticLine : `${diagnosticLine}${outputLine}`,
    exitCode,
  }
}

/**
 * Put a {@link Result}'s bytes on the real streams, returning the exit code.
 *
 * **This is the only function in the CLI that writes to `process.stdout`.** It exists because
 * E1 gave the byte-producing path a second caller: `dogear init` reaches its implementation
 * through a dynamic `import()`, so it resolves as an `Async` outcome and has to write its own
 * output rather than handing bytes back to ./cli.ts. Two copies of the three lines below is
 * how the empty-string rule gets broken in one of them and nowhere else — which is silent,
 * because A4's zero-bytes guard only ever spawns `dogear hook`.
 *
 * `write('')` is a genuine no-op: zero bytes reach the file descriptor. That is what lets the
 * empty case live in `emit()` rather than in a branch at each call site, and it is not a
 * micro-optimisation — Claude Code injects a `UserPromptSubmit` hook's stdout verbatim as
 * context, so a blank line written for an empty queue is a blank line in front of every prompt
 * the user types.
 */
export function write(result: Result): number {
  const { stdout, stderr, exitCode } = emit(result)

  process.stdout.write(stdout)
  process.stderr.write(stderr)

  return exitCode
}
