import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Annotation } from './annotation.js'
import { stampAnnotation } from './annotation.js'
import {
  appendToQueue,
  pruneQueue,
  queuePathFor,
  readQueue,
  resolveInQueue,
} from './queue.js'

/**
 * The writers D1 added: `resolveInQueue` and `pruneQueue`.
 *
 * Both inherit the two concurrency rules from `appendToQueue`, so both get the same
 * `RE-READS` guard it has — a second writer in one repo is no longer hypothetical now that
 * the MCP server resolves while a dev server is still appending.
 */

let root: string
let queuePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-write-queue-'))
  queuePath = queuePathFor(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function annotation(
  comment: string,
  status: Annotation['status'] = 'pending',
): Annotation {
  return { ...stampAnnotation({ comment }), status }
}

/** Write the queue file directly, standing in for another process. */
function writeBehindItsBack(items: readonly Annotation[]): void {
  writeFileSync(
    queuePath,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items }),
  )
}

function idOf(comment: string): string {
  const found = readQueue(queuePath).items.find((item) => item.comment === comment)
  if (found === undefined) throw new Error(`no item commented ${comment}`)
  return found.id
}

describe('resolveInQueue', () => {
  it('flips a matched pending item to resolved and stamps resolvedAt', () => {
    appendToQueue(queuePath, [annotation('done me')])
    const now = new Date('2026-08-13T12:00:00.000Z')

    const result = resolveInQueue(queuePath, [idOf('done me')], now)

    expect(result).toEqual({ resolved: 1, remaining: 0 })

    const [item] = readQueue(queuePath).items
    expect(item?.status).toBe('resolved')
    expect(item?.resolvedAt).toBe('2026-08-13T12:00:00.000Z')
  })

  it('resolves a whole batch of ids in one call', () => {
    appendToQueue(queuePath, [annotation('a'), annotation('b'), annotation('c')])

    const result = resolveInQueue(queuePath, [idOf('a'), idOf('c')])

    expect(result).toEqual({ resolved: 2, remaining: 1 })
  })

  it('leaves every other field on every item exactly as it was', () => {
    // Items pass through by spread rather than being reconstructed, which is what makes a
    // resolve safe against a queue carrying fields this build has never heard of.
    const rich = {
      ...stampAnnotation({ comment: 'rich' }),
      sites: [{ file: 'src/App.tsx', line: 12 }],
      element: { selector: 'button', text: 'Save' },
      somethingFromTheFuture: { nested: [1, 2, 3] },
    }
    appendToQueue(queuePath, [rich, annotation('other')])

    resolveInQueue(queuePath, [idOf('other')])

    const untouched = readQueue(queuePath).items.find((item) => item.comment === 'rich')
    expect(untouched).toEqual(rich)
  })

  it('counts an UNKNOWN id as a no-op rather than an error', () => {
    // An agent re-reading a stale transcript resolves ids that are already gone. Erroring
    // would make it think something is broken and retry.
    appendToQueue(queuePath, [annotation('still pending')])

    expect(resolveInQueue(queuePath, ['no-such-id'])).toEqual({
      resolved: 0,
      remaining: 1,
    })
  })

  it('does not touch the FILE when nothing matched', () => {
    // The strongest reading of "a no-op". A resolve that still rewrote the file would bump
    // updatedAt for nothing — and could lose a concurrent append while doing it.
    appendToQueue(queuePath, [annotation('untouched')])
    const before = readFileSync(queuePath, 'utf8')

    resolveInQueue(queuePath, ['no-such-id'])

    expect(readFileSync(queuePath, 'utf8')).toBe(before)
  })

  it('does not CREATE .dogear when the repo has never used dogear', () => {
    expect(resolveInQueue(queuePath, ['no-such-id'])).toEqual({
      resolved: 0,
      remaining: 0,
    })
    expect(existsSync(dirname(queuePath))).toBe(false)
  })

  it('does not re-resolve an already-resolved item, so resolvedAt stays honest', () => {
    appendToQueue(queuePath, [annotation('done')])
    const id = idOf('done')
    resolveInQueue(queuePath, [id], new Date('2026-08-13T12:00:00.000Z'))

    const result = resolveInQueue(queuePath, [id], new Date('2026-08-13T18:00:00.000Z'))

    expect(result.resolved).toBe(0)
    expect(readQueue(queuePath).items[0]?.resolvedAt).toBe('2026-08-13T12:00:00.000Z')
  })

  it('counts a duplicated id once', () => {
    appendToQueue(queuePath, [annotation('once')])
    const id = idOf('once')

    expect(resolveInQueue(queuePath, [id, id]).resolved).toBe(1)
  })

  it('RE-READS immediately before writing, so a second writer is not erased', () => {
    // The same guard appendToQueue carries, for the same reason. Between the two calls
    // another process appends; caching the first read would silently drop its item.
    appendToQueue(queuePath, [annotation('first'), annotation('second')])
    resolveInQueue(queuePath, [idOf('first')])

    const { items } = readQueue(queuePath)
    writeBehindItsBack([...items, annotation('from-other-server')])

    resolveInQueue(queuePath, [idOf('second')])

    expect(readQueue(queuePath).items.map((item) => item.comment)).toEqual([
      'first',
      'second',
      'from-other-server',
    ])
  })

  it('refuses to write over a corrupt queue, leaving the bytes untouched', () => {
    const corrupt = '{"version":1,"items":[ TRUNCATED'
    appendToQueue(queuePath, [annotation('precious')])
    writeFileSync(queuePath, corrupt)

    expect(() => resolveInQueue(queuePath, ['anything'])).toThrow()
    expect(readFileSync(queuePath, 'utf8')).toBe(corrupt)
  })
})

describe('pruneQueue', () => {
  it('drops resolved items and reports the count', () => {
    appendToQueue(queuePath, [
      annotation('done', 'resolved'),
      annotation('todo'),
      annotation('also done', 'resolved'),
    ])

    expect(pruneQueue(queuePath)).toEqual({ pruned: 2, remaining: 1 })
    expect(readQueue(queuePath).items.map((item) => item.comment)).toEqual(['todo'])
  })

  it('never touches pending items', () => {
    appendToQueue(queuePath, [annotation('a'), annotation('b')])

    expect(pruneQueue(queuePath)).toEqual({ pruned: 0, remaining: 2 })
  })

  it.each([
    { why: 'an unknown status', status: 'archived' },
    { why: 'a status this build once had', status: 'stale' },
  ])('KEEPS $why — the safe failure is an item that survives', ({ status }) => {
    // The same strict direction pendingOnly takes. An item vanishing from a file the user
    // thought was history is worse than one outliving a prune.
    appendToQueue(queuePath, [{ ...annotation('odd'), status } as Annotation])

    expect(pruneQueue(queuePath).pruned).toBe(0)
    expect(readQueue(queuePath).items).toHaveLength(1)
  })

  it('does not touch the FILE when there was nothing to prune', () => {
    appendToQueue(queuePath, [annotation('untouched')])
    const before = readFileSync(queuePath, 'utf8')

    pruneQueue(queuePath)

    expect(readFileSync(queuePath, 'utf8')).toBe(before)
  })

  it('does not CREATE .dogear when the repo has never used dogear', () => {
    expect(pruneQueue(queuePath)).toEqual({ pruned: 0, remaining: 0 })
    expect(existsSync(dirname(queuePath))).toBe(false)
  })

  it('RE-READS immediately before writing, so a second writer is not erased', () => {
    appendToQueue(queuePath, [annotation('done', 'resolved'), annotation('keep')])

    const { items } = readQueue(queuePath)
    writeBehindItsBack([...items, annotation('from-other-server')])

    pruneQueue(queuePath)

    expect(readQueue(queuePath).items.map((item) => item.comment)).toEqual([
      'keep',
      'from-other-server',
    ])
  })

  it('refuses to write over a corrupt queue, leaving the bytes untouched', () => {
    const corrupt = '{"version":1,"items":[ TRUNCATED'
    appendToQueue(queuePath, [annotation('precious')])
    writeFileSync(queuePath, corrupt)

    expect(() => pruneQueue(queuePath)).toThrow()
    expect(readFileSync(queuePath, 'utf8')).toBe(corrupt)
  })
})
