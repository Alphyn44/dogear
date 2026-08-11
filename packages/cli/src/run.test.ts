import { describe, expect, it } from 'vitest'

import { COMMANDS, run, usage } from './run.js'

/**
 * Split rather than loosened when `hook` landed. The unimplemented table used to be every
 * entry in COMMANDS; keeping the two lists explicit means the next command to be built has
 * to move itself across, and a command added to COMMANDS and then forgotten shows up as a
 * failure here rather than as a silently untested code path.
 */
const IMPLEMENTED = ['hook'] as const
const UNIMPLEMENTED = COMMANDS.filter(
  (command) => !(IMPLEMENTED as readonly string[]).includes(command),
)

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
      const result = run([command])
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
    const result = run(['hook'])

    expect(result.exitCode).toBe(0)
    expect(result.output).not.toContain('not implemented')
  })

  it('never exits non-zero from `hook`, whatever the queue is doing', () => {
    // A UserPromptSubmit hook that exits non-zero is surfaced as a failure, and exit code 2
    // blocks and ERASES the prompt the user typed. Nothing in dogear may do that.
    expect(run(['hook']).exitCode).toBe(0)
  })

  it('distinguishes an unknown command from an unimplemented one', () => {
    const unknown = run(['wibble'])
    expect(unknown.exitCode).toBe(1)
    expect(unknown.output).toContain("unknown command 'wibble'")
    expect(unknown.output).not.toContain('not implemented')
  })

  it('includes usage alongside an unknown command, so the shell shows a way forward', () => {
    expect(run(['wibble']).output).toContain(usage())
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
})
