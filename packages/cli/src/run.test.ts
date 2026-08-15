import { describe, expect, it } from 'vitest'

import type { Outcome, Result } from './run.js'
import { COMMANDS, isAsync, run, usage } from './run.js'

/**
 * Split rather than loosened when `hook` landed. The unimplemented table used to be every
 * entry in COMMANDS; keeping the two lists explicit means the next command to be built has
 * to move itself across, and a command added to COMMANDS and then forgotten shows up as a
 * failure here rather than as a silently untested code path. D1 moved `mcp`, D6 `prune`,
 * E1 `init`.
 *
 * Moving `prune` across is also what keeps it *out* of the `UNIMPLEMENTED` table below, and
 * that matters more than the assertion it stops making: those cases call `run([command])`, and
 * `run(['prune'])` would prune the queue of the repo this suite is running in. ./prune.test.ts
 * covers the command against temp roots; see the comment beside its dispatch in ./run.ts.
 *
 * `init` is safe in that table's place for a reason worth stating rather than trusting: its
 * dispatch is *lazy*. `run(['init'])` resolves this repo's git root and returns a continuation,
 * and nothing below ever calls it — so no `.dogear/` is created and no file in this repository
 * is touched. ./init.test.ts and ./scaffold.test.ts do the real work against temp roots.
 */
const IMPLEMENTED = ['init', 'hook', 'mcp', 'prune'] as const
const UNIMPLEMENTED = COMMANDS.filter(
  (command) => !(IMPLEMENTED as readonly string[]).includes(command),
)

/** Narrow an outcome to the synchronous kind, failing loudly if it is the async kind. */
function asResult(outcome: Outcome): Result {
  if (isAsync(outcome)) throw new Error('expected a Result, got an asynchronous outcome')
  return outcome
}

describe('run()', () => {
  it.each([
    { argv: [], why: 'a bare `dogear` should teach, not fail' },
    { argv: ['--help'], why: 'the long help flag' },
    { argv: ['-h'], why: 'the short help flag' },
  ])('prints usage and exits 0 for $argv — $why', ({ argv }) => {
    expect(run(argv)).toEqual({ output: usage(), exitCode: 0 })
  })

  it.each(UNIMPLEMENTED.map((command) => ({ command })))(
    'recognises $command but reports it unimplemented',
    ({ command }) => {
      const result = asResult(run([command]))
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('not implemented')
      expect(result.output).toContain(command)
    },
  )

  it('accounts for every command as either implemented or not', () => {
    expect([...IMPLEMENTED, ...UNIMPLEMENTED].sort()).toEqual([...COMMANDS].sort())
  })

  it('dispatches `hook` instead of reporting it unimplemented', () => {
    // Deliberately asserts only what is true regardless of this repo's own queue: run()
    // reads the real process environment, so the output depends on whether .dogear/
    // currently holds a pending item. hook.test.ts covers the behaviour against fixtures.
    const result = asResult(run(['hook']))

    expect(result.exitCode).toBe(0)
    expect(result.output).not.toContain('not implemented')
  })

  it('never exits non-zero from `hook`, whatever the queue is doing', () => {
    // A UserPromptSubmit hook that exits non-zero is surfaced as a failure, and exit code 2
    // blocks and ERASES the prompt the user typed. Nothing in dogear may do that.
    expect(asResult(run(['hook'])).exitCode).toBe(0)
  })

  it('dispatches `mcp` as an ASYNC outcome rather than bytes to write', () => {
    // This repo is a git repository, so `mcp` resolves a root and hands back a continuation.
    // Deliberately never calls run() — that would start a real server on this process's
    // stdio. mcp.test.ts covers both branches against temp directories.
    expect(isAsync(run(['mcp']))).toBe(true)
  })

  it('dispatches `init` as an ASYNC outcome, and does not run it', () => {
    // Same shape as `mcp`, for a different reason: init's implementation is behind a dynamic
    // import, so run() cannot hand back bytes. Never awaited here — the continuation would
    // scaffold THIS repository. init.test.ts and scaffold.test.ts use temp roots.
    expect(isAsync(run(['init']))).toBe(true)
  })

  it('forwards the rest of argv to `init`, which is what makes --dry-run reachable', () => {
    // The dispatcher hands the arguments over and ./init.ts validates them. Asserted through
    // the rejection because it is the only branch that produces bytes synchronously — a flag
    // that never arrived would come back as an async outcome instead.
    const rejected = asResult(run(['init', '--nope']))

    expect(rejected.exitCode).toBe(1)
    expect(rejected.output).toContain('--nope')
  })

  it('distinguishes an unknown command from an unimplemented one', () => {
    const unknown = asResult(run(['wibble']))
    expect(unknown.exitCode).toBe(1)
    expect(unknown.output).toContain("unknown command 'wibble'")
    expect(unknown.output).not.toContain('not implemented')
  })

  it('includes usage alongside an unknown command, so the shell shows a way forward', () => {
    expect(asResult(run(['wibble'])).output).toContain(usage())
  })
})

describe('usage()', () => {
  it.each(COMMANDS.map((command) => ({ command })))(
    'documents $command',
    ({ command }) => {
      expect(usage()).toContain(command)
    },
  )

  it('says `hook` is run by the agent, not by a human', () => {
    expect(usage()).toContain('your agent runs this, not you')
  })

  it.each(IMPLEMENTED.map((command) => ({ command })))(
    'does not still advertise $command as unbuilt',
    ({ command }) => {
      // The footer line named only `hook` until D1. A usage string that lies about what is
      // implemented is the first thing a new user reads.
      expect(usage()).toContain(`\`${command}\``)
    },
  )
})
