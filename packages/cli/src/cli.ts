#!/usr/bin/env node

/**
 * The `dogear` executable. Deliberately trivial: it exists so that argument handling in
 * ./run.ts and stream routing in ./emit.ts can be unit-tested without spawning a process,
 * and so that the bin wiring is real from the first commit rather than appearing at E1.
 *
 * There is no decision left in this file, and that is the point — every branch that used
 * to live here is now a value ./emit.test.ts can assert on.
 */

import { emit } from './emit.js'
import { run } from './run.js'

const { stdout, stderr, exitCode } = emit(run(process.argv.slice(2)))

// Unconditional, and `write('')` is a genuine no-op — zero bytes reach the file
// descriptor. That is what lets the branch live in emit() instead of here. It matters
// more than it looks: `dogear hook` runs on every prompt the user types, and Claude Code
// injects a UserPromptSubmit hook's stdout verbatim as context, so writing a blank line
// for an empty queue would put a blank line in front of every prompt.
process.stdout.write(stdout)
process.stderr.write(stderr)

process.exitCode = exitCode
