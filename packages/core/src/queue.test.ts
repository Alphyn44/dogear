import { describe, expect, it } from 'vitest'

import type { AnnotationDraft } from './queue.js'
import { acceptableComment, createQueue } from './queue.js'

/**
 * Node environment, no docblock — the queue is pure data. That is the whole reason it is not
 * a closure variable inside session.ts.
 */

function draft(comment: string): AnnotationDraft {
  return {
    comment,
    element: { tag: 'button', id: null, classes: ['tab'], text: 'Settings' },
    url: 'http://localhost:5173/settings',
    viewport: { w: 1512, h: 945, dpr: 2 },
    authoredAt: '2026-08-11T10:00:00.000Z',
  }
}

describe('createQueue', () => {
  it('starts empty', () => {
    const queue = createQueue()

    expect(queue.count).toBe(0)
    expect(queue.items).toEqual([])
  })

  it('appends oldest-first and counts', () => {
    const queue = createQueue()

    queue.add(draft('first'))
    queue.add(draft('second'))

    expect(queue.count).toBe(2)
    expect(queue.items.map((item) => item.comment)).toEqual(['first', 'second'])
  })

  it('stores every draft field verbatim', () => {
    const queue = createQueue()
    const input = draft('too dark')

    const stored = queue.add(input)

    expect(stored).toEqual({ ...input, key: expect.any(Number) })
  })

  it('returns the stored item, so the caller has its key without a re-read', () => {
    const queue = createQueue()

    const stored = queue.add(draft('too dark'))

    expect(queue.items[0]).toEqual(stored)
  })

  it('gives every item a distinct key', () => {
    const queue = createQueue()

    const keys = ['a', 'b', 'c'].map((comment) => queue.add(draft(comment)).key)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never reuses a key, so B4 (#11) cannot delete one item and edit another', () => {
    // The property that array indices do *not* have, and the entire reason `key` exists.
    // Simulated by hand because the queue has no `remove` until B4: what matters is that a
    // key issued after other items existed can never collide with one issued before.
    const queue = createQueue()

    const first = queue.add(draft('a'))
    const second = queue.add(draft('b'))
    const third = queue.add(draft('c'))

    expect(second.key).toBeGreaterThan(first.key)
    expect(third.key).toBeGreaterThan(second.key)
  })

  it('hands out a copy, so a consumer cannot splice the only record of the batch', () => {
    const queue = createQueue()
    queue.add(draft('keep me'))

    const taken = queue.items as QueueItemArray
    taken.length = 0

    expect(queue.count).toBe(1)
  })
})

describe('remove', () => {
  it('drops the item with that key', () => {
    const queue = createQueue()
    const first = queue.add(draft('a'))
    queue.add(draft('b'))

    expect(queue.remove(first.key)).toBe(true)
    expect(queue.items.map((item) => item.comment)).toEqual(['b'])
  })

  it('reports a key that matched nothing', () => {
    const queue = createQueue()
    queue.add(draft('a'))

    expect(queue.remove(9999)).toBe(false)
    expect(queue.count).toBe(1)
  })

  it('leaves the surviving items keyed exactly as they were', () => {
    // The property array indices do not have, and the reason B4 (#11) addresses rows by key.
    // Dropping the first item must not renumber the third into the second's handler.
    const queue = createQueue()
    const [, second, third] = [
      queue.add(draft('a')),
      queue.add(draft('b')),
      queue.add(draft('c')),
    ]

    queue.remove(queue.items[0]?.key ?? -1)

    expect(queue.items.map((item) => item.key)).toEqual([second?.key, third?.key])
  })

  it('empties cleanly, so B7 (#14) can unmount', () => {
    const queue = createQueue()
    const only = queue.add(draft('a'))

    queue.remove(only.key)

    expect(queue.count).toBe(0)
    expect(queue.items).toEqual([])
  })
})

describe('update', () => {
  it('replaces the comment and nothing else', () => {
    const queue = createQueue()
    const item = queue.add(draft('before'))

    expect(queue.update(item.key, 'after')).toBe(true)
    expect(queue.items[0]).toEqual({ ...item, comment: 'after' })
  })

  it('reports a key that matched nothing', () => {
    const queue = createQueue()

    expect(queue.update(9999, 'after')).toBe(false)
  })

  it('replaces rather than mutates, so a held reference sees a consistent snapshot', () => {
    const queue = createQueue()
    const held = queue.add(draft('before'))

    queue.update(held.key, 'after')

    expect(held.comment).toBe('before')
    expect(queue.items[0]?.comment).toBe('after')
  })

  it('edits the right item when others share a comment', () => {
    const queue = createQueue()
    queue.add(draft('same'))
    const second = queue.add(draft('same'))

    queue.update(second.key, 'changed')

    expect(queue.items.map((item) => item.comment)).toEqual(['same', 'changed'])
  })
})

describe('acceptableComment', () => {
  it.each([
    { raw: 'too dark', expected: 'too dark', why: 'an ordinary comment passes through' },
    {
      raw: '  too dark  ',
      expected: 'too dark',
      why: 'trimmed, as validateBatch requires',
    },
    { raw: '', expected: null, why: 'empty is refused' },
    { raw: '   ', expected: null, why: 'whitespace is refused' },
    { raw: '\n\t ', expected: null, why: 'so is whitespace that is not spaces' },
    {
      raw: 'line\nline',
      expected: 'line\nline',
      why: 'an interior newline is a Shift+Enter, not emptiness',
    },
  ])('$why', ({ raw, expected }) => {
    expect(acceptableComment(raw)).toBe(expected)
  })
})

/** The mutable view the copy test needs. `items` is readonly precisely so this needs a cast. */
type QueueItemArray = { length: number }
