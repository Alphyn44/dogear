#!/usr/bin/env node

/**
 * The `dogear` executable. Deliberately trivial: it exists so that argument handling
 * in ./run.ts can be unit-tested without spawning a process, and so that the bin
 * wiring is real from the first commit rather than appearing at E1.
 */

import { run } from './run.js'

const { output, exitCode } = run(process.argv.slice(2))

// stdout for success, stderr for anything the shell should treat as a failure.
if (exitCode === 0) {
  process.stdout.write(`${output}\n`)
} else {
  process.stderr.write(`${output}\n`)
}

process.exitCode = exitCode
