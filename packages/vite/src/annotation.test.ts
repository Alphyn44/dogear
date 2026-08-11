import { beforeEach, describe, expect, it } from 'vitest'

import { createUuidv7, stampAnnotation, uuidv7, validateBatch } from './annotation.js'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuidv7', () => {
  // A fresh generator per test. The shared `uuidv7` export deliberately cannot be rewound,
  // so reusing it here would make every fixed-timestamp assertion below silently test the
  // clock-went-backwards path instead of what it claims to.
  let next: (now?: number) => string

  beforeEach(() => {
    next = createUuidv7()
  })

  it('matches the RFC 9562 layout — version 7, variant 10xx', () => {
    expect(next()).toMatch(UUID_SHAPE)
  })

  it('encodes the timestamp in the leading 48 bits, big-endian', () => {
    const now = 1_775_000_000_000
    const hex = next(now).replaceAll('-', '').slice(0, 12)

    expect(Number.parseInt(hex, 16)).toBe(now)
  })

  it('sorts chronologically as a plain string, which is why the queue needs no sort', () => {
    const ids = [1_775_000_000_000, 1_775_000_000_001, 1_775_000_001_000].map((ms) =>
      next(ms),
    )

    expect([...ids].sort()).toEqual(ids)
  })

  it('stays ordered within a single millisecond — one batch is one millisecond', () => {
    // The reason rand_a carries a counter instead of randomness. Without it these would
    // come back shuffled, and a batch of five comments is exactly when someone would look.
    const ids = Array.from({ length: 50 }, () => next(1_775_000_002_000))

    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never repeats an id when the clock jumps backwards', () => {
    const forward = next(1_775_000_010_000)
    const backward = Array.from({ length: 5 }, () => next(1_775_000_000_000))

    expect(new Set([forward, ...backward]).size).toBe(6)
    // The rewound clock must not rewind the ids; ordering survives a bad NTP correction.
    expect([forward, ...backward].sort()).toEqual([forward, ...backward])
  })

  it('stays a valid UUIDv7 after the 12-bit counter overflows', () => {
    // 4096 ids inside one millisecond. Before the overflow guard this corrupted the
    // version nibble, producing something that was not a UUID at all.
    const ids = Array.from({ length: 4_200 }, () => next(1_775_000_020_000))

    expect(ids.every((id) => UUID_SHAPE.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('the shared generator produces valid ids too — it is what stamping uses', () => {
    expect(uuidv7()).toMatch(UUID_SHAPE)
  })
})

describe('stampAnnotation', () => {
  const now = new Date('2026-08-10T12:00:00.000Z')

  it('stamps the four server-owned fields', () => {
    const stamped = stampAnnotation({ comment: 'make this darker' }, now)

    expect(stamped).toMatchObject({
      comment: 'make this darker',
      status: 'pending',
      createdAt: '2026-08-10T12:00:00.000Z',
      resolvedAt: null,
    })
    expect(stamped.id).toMatch(UUID_SHAPE)
  })

  it('preserves client fields the server knows nothing about', () => {
    // The C epic adds sites, element, viewport and more. This module must not be a
    // bottleneck those have to be threaded through.
    const stamped = stampAnnotation(
      { comment: 'x', element: { tag: 'button' }, viewport: { w: 1512 } },
      now,
    )

    expect(stamped['element']).toEqual({ tag: 'button' })
    expect(stamped['viewport']).toEqual({ w: 1512 })
  })

  it.each([
    { field: 'status', sent: 'resolved', expected: 'pending' },
    { field: 'resolvedAt', sent: '2020-01-01T00:00:00.000Z', expected: null },
  ])('overwrites a client-supplied $field — the server owns lifecycle', (testCase) => {
    const stamped = stampAnnotation(
      { comment: 'x', [testCase.field]: testCase.sent },
      now,
    )

    expect(stamped[testCase.field]).toBe(testCase.expected)
  })

  it('overwrites a client-supplied id, so ids cannot be forged or collided', () => {
    const stamped = stampAnnotation({ comment: 'x', id: 'not-a-uuid' }, now)

    expect(stamped.id).not.toBe('not-a-uuid')
    expect(stamped.id).toMatch(UUID_SHAPE)
  })
})

describe('validateBatch', () => {
  const valid = { version: 1, batch: [{ comment: 'make this darker' }] }

  it('accepts the documented shape', () => {
    const result = validateBatch(valid)

    expect(result.ok).toBe(true)
  })

  it('accepts an empty batch — not malformed, just nothing to do', () => {
    expect(validateBatch({ version: 1, batch: [] }).ok).toBe(true)
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
