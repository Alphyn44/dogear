import { describe, expect, it } from 'vitest'

import { validateBatch } from './batch.js'

/**
 * Split out of ./annotation.test.ts when D1 moved annotation identity into `@dogear/queue`.
 * Every assertion is unchanged; only the module under test moved.
 */

describe('validateBatch', () => {
  const valid = { version: 1, batch: [{ comment: 'make this darker' }] }

  it('accepts the documented shape', () => {
    const result = validateBatch(valid)

    expect(result.ok).toBe(true)
  })

  it('accepts an empty batch — not malformed, just nothing to do', () => {
    expect(validateBatch({ version: 1, batch: [] }).ok).toBe(true)
  })

  // B5 (#12) — the batch note.
  it.each([
    { why: 'absent', body: valid, expected: undefined },
    {
      why: 'a real instruction',
      body: { ...valid, note: 'all on the settings page' },
      expected: 'all on the settings page',
    },
    {
      why: 'trimmed',
      body: { ...valid, note: '  spaced out \n' },
      expected: 'spaced out',
    },
    {
      // Whitespace reads as absent. The overlay already omits an empty note, so this is the
      // hand-written `curl` path — and one representation of "no instruction" is worth more
      // in the queue file than recording that someone typed three spaces.
      why: 'only whitespace, which reads as absent',
      body: { ...valid, note: '   ' },
      expected: undefined,
    },
    { why: 'an empty string', body: { ...valid, note: '' }, expected: undefined },
  ])('carries the note when it is $why', ({ body, expected }) => {
    const result = validateBatch(body)

    expect(result.ok).toBe(true)
    expect(result.ok === true && result.note).toBe(expected)
  })

  it.each([
    { why: 'an array is not an envelope', body: [], error: 'body must be a JSON object' },
    { why: 'null is not an envelope', body: null, error: 'body must be a JSON object' },
    {
      why: 'a string is not an envelope',
      body: 'hi',
      error: 'body must be a JSON object',
    },
    { why: 'the version is missing', body: { batch: [] }, error: 'version must be 1' },
    {
      why: 'the version is from a future protocol',
      body: { version: 2, batch: [] },
      error: 'version must be 1',
    },
    { why: 'batch is missing', body: { version: 1 }, error: 'batch must be an array' },
    {
      why: 'batch is an object',
      body: { version: 1, batch: {} },
      error: 'batch must be an array',
    },
    {
      why: 'an item is not an object',
      body: { version: 1, batch: ['just a string'] },
      error: 'batch[0] must be an object',
    },
    {
      why: 'a comment is missing',
      body: { version: 1, batch: [{ element: {} }] },
      error: 'batch[0].comment must be a non-empty string',
    },
    {
      why: 'a comment is empty',
      body: { version: 1, batch: [{ comment: '' }] },
      error: 'batch[0].comment must be a non-empty string',
    },
    {
      why: 'a comment is only whitespace',
      body: { version: 1, batch: [{ comment: '   \n ' }] },
      error: 'batch[0].comment must be a non-empty string',
    },
    {
      why: 'a comment is a number',
      body: { version: 1, batch: [{ comment: 42 }] },
      error: 'batch[0].comment must be a non-empty string',
    },
    {
      // B5 (#12). Rejected rather than coerced: the note is copied onto every item, so
      // `String(value)` would write "[object Object]" across the whole batch silently.
      why: 'the note is not a string',
      body: { version: 1, batch: [{ comment: 'x' }], note: { text: 'nope' } },
      error: 'note must be a string when present',
    },
    {
      why: 'the note is a number',
      body: { version: 1, batch: [{ comment: 'x' }], note: 7 },
      error: 'note must be a string when present',
    },
  ])('rejects when $why', ({ body, error }) => {
    const result = validateBatch(body)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors.join('\n')).toContain(error)
  })

  it('names the failing index, so a hand-written curl batch is fixable', () => {
    const result = validateBatch({
      version: 1,
      batch: [{ comment: 'fine' }, { comment: '' }, { comment: 'also fine' }],
    })

    expect(result.ok === false && result.errors).toEqual([
      'batch[1].comment must be a non-empty string',
    ])
  })

  it('reports every problem at once rather than one per round trip', () => {
    const result = validateBatch({ version: 9, batch: [{}, {}] })

    expect(result.ok === false && result.errors).toHaveLength(3)
  })
})
