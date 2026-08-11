#!/usr/bin/env node

/**
 * The `dogear` executable. Deliberately trivial: it exists so that argument handling
 * in ./run.ts can be unit-tested without spawning a process, and so that the bin
 * wiring is real from the first commit rather than appearing at E1.
 */

import { run } from './run.js'

const { output, exitCode, diagnostic } = run(process.argv.slice(2))

// Diagnostics are independent of the exit code — `dogear hook` reports a broken queue on
// stderr while still exiting 0, because a non-zero exit from a UserPromptSubmit hook is a
// failure Claude Code surfaces to the user, and exit code 2 erases the prompt they typed.
if (diagnostic !== undefined) process.stderr.write(`${diagnostic}\n`)

// An empty `output` writes NOTHING, not a blank line. Claude Code injects a hook's stdout
// verbatim as context, so a lone newline from an empty queue is a lone newline prepended to
// every prompt the user types.
if (output !== '') {
  // stdout for success, stderr for anything the shell should treat as a failure.
  const stream = exitCode === 0 ? process.stdout : process.stderr
  stream.write(`${output}\n`)
}

process.exitCode = exitCode
