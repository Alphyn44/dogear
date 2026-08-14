import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StoredAnnotation } from './queue.js'
import { pendingOnly, queuePathFor, tryReadQueue, withApp } from './queue.js'

/**
 * Moved from `@dogear/cli`, where this was `readQueue`'s suite before the two readers met in
 * one module. Every assertion is the same; only the symbol changed, to `tryReadQueue`.
 * ./tolerance.test.ts is what now guards the relationship between the two.
 */

let root: string
let queuePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-tolerant-queue-'))
  queuePath = queuePathFor(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write raw bytes to the queue path, standing in for a hand-written or corrupted file. */
function writeRaw(contents: string): void {
  mkdirSync(dirname(queuePath), { recursive: true })
  writeFileSync(queuePath, contents)
}

function annotation(overrides: Partial<StoredAnnotation> = {}): StoredAnnotation {
  return {
    id: '0199c8f4-3a21-7c5e-b3d9-1f2a4c6e8b07',
    status: 'pending',
    comment: 'shade this darker',
    ...overrides,
  }
}

describe('queuePathFor', () => {
  it('places the queue under .dogear at the git root', () => {
    expect(queuePathFor(root)).toBe(join(root, '.dogear', 'queue.json'))
  })
})

describe('tryReadQueue', () => {
  it('treats a missing file as an empty queue, not a failure', () => {
    // A repo that has never had an annotation is the common case. Reporting it would put a
    // diagnostic on stderr for every prompt typed in every repo with the hook installed.
    expect(tryReadQueue(queuePath)).toEqual({ ok: true, items: [] })
  })

  it('reads the items out of a well-formed queue', () => {
    const item = annotation()
    writeRaw(JSON.stringify({ version: 1, updatedAt: null, items: [item] }))

    expect(tryReadQueue(queuePath)).toEqual({ ok: true, items: [item] })
  })

  it('reads an empty items array as an empty queue', () => {
    writeRaw(JSON.stringify({ version: 1, updatedAt: null, items: [] }))

    expect(tryReadQueue(queuePath)).toEqual({ ok: true, items: [] })
  })

  it.each([
    { why: 'the JSON is truncated', contents: '{"version":1,"items":[' },
    { why: 'the file is empty', contents: '' },
    { why: 'the file is not an object', contents: '[]' },
    { why: 'the file is a bare string', contents: '"nope"' },
    { why: 'there is no items array', contents: '{"version":1}' },
    { why: 'items is not an array', contents: '{"version":1,"items":{}}' },
    { why: 'the schema version is unknown', contents: '{"version":99,"items":[]}' },
    { why: 'the schema version is missing', contents: '{"items":[]}' },
  ])('degrades to a reason rather than throwing when $why', ({ contents }) => {
    writeRaw(contents)

    // The whole point of this reader: the plugin throws here so its endpoint can answer 500
    // and leave the bytes alone, but a hook that throws exits non-zero on someone's prompt.
    const result = tryReadQueue(queuePath)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain(queuePath)
    expect(result.reason).not.toBe('')
  })

  it.each([
    { why: 'a null entry', item: null },
    { why: 'an array entry', item: [] },
    { why: 'a bare string entry', item: 'not an annotation' },
    { why: 'no id', item: { status: 'pending', comment: 'x' } },
    { why: 'no comment', item: { id: 'a', status: 'pending' } },
    { why: 'a non-string status', item: { id: 'a', status: 1, comment: 'x' } },
  ])('drops $why without failing the whole read', ({ item }) => {
    // One malformed entry in a hand-edited file should cost that entry, not the other nine.
    const good = annotation()
    writeRaw(JSON.stringify({ version: 1, updatedAt: null, items: [item, good] }))

    expect(tryReadQueue(queuePath)).toEqual({ ok: true, items: [good] })
  })
})

describe('pendingOnly', () => {
  it('keeps pending items and drops everything else', () => {
    const pending = annotation({ id: 'pending-1' })
    const resolved = annotation({ id: 'resolved-1', status: 'resolved' })

    expect(pendingOnly([pending, resolved])).toEqual([pending])
  })

  it.each([
    { why: 'an unknown status', status: 'archived' },
    { why: 'a status this build once had', status: 'stale' },
    { why: 'the empty string', status: '' },
    { why: 'a case mismatch', status: 'Pending' },
  ])('excludes $why — the strict direction is the safe one', ({ status }) => {
    // A resolved item resurfacing is worse than a hand-written item being ignored: the
    // second is visible in the file, the first looks like the agent forgot it did the work.
    expect(pendingOnly([annotation({ status })])).toEqual([])
  })

  it('preserves order, which is chronological because ids are UUIDv7', () => {
    const first = annotation({ id: 'a' })
    const second = annotation({ id: 'b' })
    const third = annotation({ id: 'c' })

    expect(pendingOnly([first, second, third])).toEqual([first, second, third])
  })
})

describe('withApp', () => {
  it('keeps only items from the named workspace package', () => {
    const admin = annotation({ id: 'a', app: '@acme/admin' })
    const site = annotation({ id: 'b', app: '@acme/site' })

    expect(withApp([admin, site], '@acme/admin')).toEqual([admin])
  })

  it('EXCLUDES an item carrying no app rather than including it', () => {
    // Items written before C4 have no `app` at all, and the brief's wording is "filtered to
    // one workspace package" — singular. An annotation that never recorded where it came
    // from cannot be claimed by a package.
    const anonymous = annotation({ id: 'a' })
    const admin = annotation({ id: 'b', app: '@acme/admin' })

    expect(withApp([anonymous, admin], '@acme/admin')).toEqual([admin])
  })

  it.each([
    { why: 'a case mismatch', app: '@ACME/admin' },
    { why: 'a bare suffix', app: 'admin' },
    { why: 'a prefix', app: '@acme' },
  ])('does not match on $why — the filter is exact', ({ app }) => {
    expect(withApp([annotation({ app: '@acme/admin' })], app)).toEqual([])
  })

  it('returns nothing when no item carries an app at all', () => {
    expect(
      withApp([annotation({ id: 'a' }), annotation({ id: 'b' })], '@acme/admin'),
    ).toEqual([])
  })
})
