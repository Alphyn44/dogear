import { beforeEach, describe, expect, it } from 'vitest'

import { createUuidv7, stampAnnotation, uuidv7 } from './annotation.js'

/**
 * Moved from `dogear-vite` with the code it covers. `validateBatch`'s suite stayed behind
 * as `packages/vite/src/batch.test.ts`, because the POST body it validates is the plugin's
 * wire contract rather than anything this package knows about.
 */

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
    const stamped = stampAnnotation({ comment: 'make this darker' }, { now })

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
      { now },
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
      { now },
    )

    expect(stamped[testCase.field]).toBe(testCase.expected)
  })

  it('overwrites a client-supplied id, so ids cannot be forged or collided', () => {
    const stamped = stampAnnotation({ comment: 'x', id: 'not-a-uuid' }, { now })

    expect(stamped.id).not.toBe('not-a-uuid')
    expect(stamped.id).toMatch(UUID_SHAPE)
  })

  // B5 (#12). The note is batch-wide but stored per item, because everything downstream of
  // the queue file is per-item — see the brief's Decisions log.
  it('stamps the batch note onto the annotation', () => {
    const stamped = stampAnnotation(
      { comment: 'x' },
      { note: 'all on the settings page', now },
    )

    expect(stamped['note']).toBe('all on the settings page')
  })

  it('omits note entirely when there is none, rather than writing an empty string', () => {
    // One representation of "no instruction" in a file people read with `cat`.
    expect('note' in stampAnnotation({ comment: 'x' }, { now })).toBe(false)
  })

  it('lets the batch note win over a per-item note the client had no business sending', () => {
    const stamped = stampAnnotation(
      { comment: 'x', note: 'smuggled' },
      { note: 'real', now },
    )

    expect(stamped['note']).toBe('real')
  })

  it('still cannot forge lifecycle through the note slot', () => {
    // The spread order is client → note → server-owned. This pins the second boundary: the
    // note goes in ahead of `status`, so it can never displace it.
    const stamped = stampAnnotation({ comment: 'x' }, { note: 'n', now })

    expect(stamped.status).toBe('pending')
    expect(stamped.resolvedAt).toBeNull()
  })

  // C4 (#18).
  it('stamps origin and app', () => {
    const stamped = stampAnnotation(
      { comment: 'x' },
      { origin: 'http://localhost:5173', app: '@acme/admin', now },
    )

    expect(stamped['origin']).toBe('http://localhost:5173')
    expect(stamped['app']).toBe('@acme/admin')
  })

  it.each(['origin', 'app'])(
    'omits %s entirely when the server resolved none',
    (field) => {
      // Absent rather than `undefined`-valued: JSON.stringify drops the key either way, so
      // writing it would make the annotation and its serialized form disagree about which
      // fields exist.
      expect(field in stampAnnotation({ comment: 'x' }, { now })).toBe(false)
    },
  )

  it('overwrites a client-supplied origin and app — the server owns both', () => {
    // Same boundary as the id. A batch from one dev server must not be able to claim it came
    // from another, which is exactly the ambiguity C4 exists to remove.
    const stamped = stampAnnotation(
      { comment: 'x', origin: 'http://evil.example', app: '@someone-elses/package' },
      { origin: 'http://localhost:5173', app: '@acme/admin', now },
    )

    expect(stamped['origin']).toBe('http://localhost:5173')
    expect(stamped['app']).toBe('@acme/admin')
  })

  it('discards a client value even when the server resolved none of its own', () => {
    // The sharp edge a conditional spread alone would leave: with nothing to overwrite it,
    // the client's value would ride straight through into the queue. A repo whose package
    // declares no name is exactly where a bogus `app` would go unnoticed.
    const stamped = stampAnnotation(
      { comment: 'x', origin: 'http://evil.example', app: '@someone-elses/package' },
      { now },
    )

    expect('origin' in stamped).toBe(false)
    expect('app' in stamped).toBe(false)
  })
})
