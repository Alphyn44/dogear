#!/usr/bin/env node

/**
 * The `dogear` executable. Deliberately trivial: it exists so that argument handling in
 * ./run.ts and stream routing in ./emit.ts can be unit-tested without spawning a process,
 * and so that the bin wiring is real from the first commit rather than appearing at E1.
 *
 * **One branch lives here, and only one.** It is not a policy decision — ./run.ts still owns
 * every one of those — but the difference between the two kinds of thing a command can be:
 *
 * - A command that **produces bytes and exits**. ./emit.ts decides which stream they go to;
 *   this file writes them.
 * - A command that **owns the streams until its client disconnects**. `dogear mcp` frames
 *   JSON-RPC on stdin and stdout for its whole lifetime, so there is nothing to write here
 *   and writing anything at all would corrupt the protocol.
 *
 * That distinction cannot live in `emit()`, because `emit()`'s job is to turn an outcome
 * into bytes and a serving command has none. It is a value either way — `isServe` — so
 * ./run.test.ts still asserts on it without spawning anything.
 */

import { emit } from './emit.js'
import { isServe, run } from './run.js'

const outcome = run(process.argv.slice(2))

if (isServe(outcome)) {
  // Nothing is written here. From this point the transport owns stdout.
  process.exitCode = await outcome.serve()
} else {
  const { stdout, stderr, exitCode } = emit(outcome)

  // Unconditional, and `write('')` is a genuine no-op — zero bytes reach the file
  // descriptor. That is what lets the branch live in emit() instead of here. It matters
  // more than it looks: `dogear hook` runs on every prompt the user types, and Claude Code
  // injects a UserPromptSubmit hook's stdout verbatim as context, so writing a blank line
  // for an empty queue would put a blank line in front of every prompt.
  process.stdout.write(stdout)
  process.stderr.write(stderr)

  process.exitCode = exitCode
}
