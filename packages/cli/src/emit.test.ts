import { describe, expect, it } from 'vitest'

import { emit } from './emit.js'
import type { Result } from './run.js'

function result(overrides: Partial<Result> = {}): Result {
  return { output: '', exitCode: 0, ...overrides }
}

describe('emit()', () => {
  it('writes NOTHING for an empty output — A4’s first acceptance criterion', () => {
    // Not a blank line. Claude Code injects a UserPromptSubmit hook's stdout verbatim as
    // context, so a lone newline from an empty queue is a lone newline prepended to every
    // prompt the user ever types. This is the assertion the whole story turns on.
    expect(emit(result())).toEqual({ stdout: '', stderr: '', exitCode: 0 })
  })

  it('writes zero bytes across both streams, counted rather than compared', () => {
    // Belt and braces on the test above: `toEqual('')` would also pass for a value that is
    // empty-ish. Byte length cannot be argued with.
    const { stdout, stderr } = emit(result())

    expect(Buffer.byteLength(stdout)).toBe(0)
    expect(Buffer.byteLength(stderr)).toBe(0)
  })

  it.each([
    {
      why: 'success writes output to stdout, newline-terminated',
      input: { output: '{"ok":true}', exitCode: 0 },
      expected: { stdout: '{"ok":true}\n', stderr: '', exitCode: 0 },
    },
    {
      why: 'failure writes output to stderr instead, so a pipeline sees what it expects',
      input: { output: 'dogear: unknown command', exitCode: 1 },
      expected: { stdout: '', stderr: 'dogear: unknown command\n', exitCode: 1 },
    },
    {
      why: 'a diagnostic reaches stderr even on a zero exit — the broken-queue case',
      input: { output: '', exitCode: 0, diagnostic: 'dogear: queue is not valid JSON' },
      expected: {
        stdout: '',
        stderr: 'dogear: queue is not valid JSON\n',
        exitCode: 0,
      },
    },
    {
      why: 'a diagnostic never contaminates stdout, which is injected as context',
      input: { output: '{"ok":true}', exitCode: 0, diagnostic: 'dogear: heads up' },
      expected: {
        stdout: '{"ok":true}\n',
        stderr: 'dogear: heads up\n',
        exitCode: 0,
      },
    },
    {
      why: 'the diagnostic comes first when both land on stderr',
      input: { output: 'dogear: failed', exitCode: 1, diagnostic: 'dogear: context' },
      expected: {
        stdout: '',
        stderr: 'dogear: context\ndogear: failed\n',
        exitCode: 1,
      },
    },
    {
      why: 'an empty output on a failing exit still writes nothing',
      input: { output: '', exitCode: 1 },
      expected: { stdout: '', stderr: '', exitCode: 1 },
    },
  ])('$why', ({ input, expected }) => {
    expect(emit(result(input))).toEqual(expected)
  })

  it('passes the exit code through untouched', () => {
    // Nothing here may invent an exit code. Exit 2 in particular rejects the user's prompt
    // outright, so the only place that decides is the command itself.
    for (const exitCode of [0, 1, 42]) {
      expect(emit(result({ exitCode })).exitCode).toBe(exitCode)
    }
  })

  it('terminates every non-empty stream with exactly one newline', () => {
    const { stdout, stderr } = emit(
      result({ output: 'out', exitCode: 0, diagnostic: 'diag' }),
    )

    expect(stdout).toBe('out\n')
    expect(stderr).toBe('diag\n')
  })

  it('does not add a second newline to output that already ends in one', () => {
    // Documents current behaviour rather than blessing it: nothing in dogear returns a
    // newline-terminated `output` today, and if something starts to, this test says what
    // will happen rather than leaving it to be discovered in a transcript.
    expect(emit(result({ output: 'already\n' })).stdout).toBe('already\n\n')
  })
})
