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
 * into bytes and an asynchronous command has none to hand back. It is a value either way —
 * `isAsync` — so ./run.test.ts still asserts on it without spawning anything.
 *
 * Note that "asynchronous" is not "silent": `dogear mcp` writes nothing here because the
 * transport owns stdout, while `dogear init` writes ordinary bytes through the same
 * `write()` this file calls — it simply does so after its dynamic import resolves. See
 * ./run.ts's `Async` for why both land in one variant.
 */

import { write } from './emit.js'
import { isAsync, run } from './run.js'

const outcome = run(process.argv.slice(2))

// `write()` rather than three statements inline: E1 gave the byte-producing path a second
// caller in ./init.ts, and the empty-string-means-zero-bytes rule has to hold in both.
process.exitCode = isAsync(outcome) ? await outcome.run() : write(outcome)
