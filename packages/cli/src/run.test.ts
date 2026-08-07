import { describe, expect, it } from 'vitest'

import { COMMANDS, run, usage } from './run.js'

describe('run()', () => {
  it.each([
    { argv: [], why: 'a bare `dogear` should teach, not fail' },
    { argv: ['--help'], why: 'the long help flag' },
    { argv: ['-h'], why: 'the short help flag' },
  ])('prints usage and exits 0 for $argv — $why', ({ argv }) => {
    expect(run(argv)).toEqual({ output: usage(), exitCode: 0 })
  })

  it.each(COMMANDS.map((command) => ({ command })))(
    'recognises $command but reports it unimplemented',
    ({ command }) => {
      const result = run([command])
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('not implemented')
      expect(result.output).toContain(command)
    },
  )

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
})
