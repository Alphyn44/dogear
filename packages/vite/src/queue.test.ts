import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Annotation } from './annotation.js'
import { stampAnnotation } from './annotation.js'
import { appendToQueue, queuePathFor, readQueue, tempPathFor } from './queue.js'

let root: string
let queuePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-queue-'))
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

/** Write the queue file directly, standing in for a second dev server process. */
function writeBehindItsBack(items: readonly Annotation[]): void {
  writeFileSync(
    queuePath,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items }),
  )
}

describe('queuePathFor', () => {
  it('places the queue under .dogear at the git root', () => {
    expect(queuePathFor(root)).toBe(join(root, '.dogear', 'queue.json'))
  })
})

describe('readQueue', () => {
  it('treats a missing file as an empty queue — the first annotation is not an error', () => {
    expect(readQueue(queuePath)).toEqual({ version: 1, updatedAt: null, items: [] })
  })

  it.each([
    { why: 'the JSON is truncated', contents: '{"version":1,"items":[' },
    { why: 'the file is not an object', contents: '[]' },
    { why: 'there is no items array', contents: '{"version":1}' },
    { why: 'items is not an array', contents: '{"version":1,"items":{}}' },
    {
      why: 'the schema is from a newer dogear',
      contents: '{"version":2,"items":[]}',
    },
  ])('throws when $why, rather than reporting an empty queue', ({ contents }) => {
    appendToQueue(queuePath, [])
    writeFileSync(queuePath, contents)

    expect(() => readQueue(queuePath)).toThrow()
  })
})

describe('appendToQueue', () => {
  it('creates .dogear and the file on the first write', () => {
    expect(existsSync(dirname(queuePath))).toBe(false)

    appendToQueue(queuePath, [annotation('first')])

    expect(readQueue(queuePath).items).toHaveLength(1)
  })

  it('writes the documented shape', () => {
    appendToQueue(queuePath, [annotation('first')])

    const parsed = JSON.parse(readFileSync(queuePath, 'utf8')) as Record<string, unknown>

    expect(Object.keys(parsed)).toEqual(['version', 'updatedAt', 'items'])
    expect(parsed['version']).toBe(1)
    expect(typeof parsed['updatedAt']).toBe('string')
  })

  it('appends oldest-first rather than replacing', () => {
    appendToQueue(queuePath, [annotation('first')])
    appendToQueue(queuePath, [annotation('second')])

    expect(readQueue(queuePath).items.map((item) => item.comment)).toEqual([
      'first',
      'second',
    ])
  })

  it('writes a whole batch in one call', () => {
    const result = appendToQueue(queuePath, [annotation('a'), annotation('b')])

    expect(result.written).toBe(2)
    expect(readQueue(queuePath).items).toHaveLength(2)
  })

  it('RE-READS immediately before writing, so a second dev server is not erased', () => {
    // The single most important assertion in this file. appendToQueue must never hold
    // queue state across calls: between our two calls, another process appends. Caching
    // the array read during the first call would silently drop 'from-other-server'.
    appendToQueue(queuePath, [annotation('ours-first')])

    const { items } = readQueue(queuePath)
    writeBehindItsBack([...items, annotation('from-other-server')])

    appendToQueue(queuePath, [annotation('ours-second')])

    expect(readQueue(queuePath).items.map((item) => item.comment)).toEqual([
      'ours-first',
      'from-other-server',
      'ours-second',
    ])
  })

  it('leaves no temp file behind', () => {
    appendToQueue(queuePath, [annotation('first')])

    expect(readdirSync(dirname(queuePath))).toEqual(['queue.json'])
  })

  it('names the temp file with this process id, so two writers cannot collide', () => {
    // A successful write renames the temp away faster than a test could observe it, so
    // this asserts the naming rule directly. Two dev servers sharing one `queue.json.tmp`
    // would interleave their bytes and rename a corrupted file into place.
    expect(tempPathFor(queuePath)).toBe(`${queuePath}.${process.pid}.tmp`)
  })

  it('keeps the temp file beside its target, since rename is only atomic within a volume', () => {
    expect(dirname(tempPathFor(queuePath))).toBe(dirname(queuePath))
  })

  it('counts only pending items, since resolved ones do not reach the agent', () => {
    appendToQueue(queuePath, [annotation('done', 'resolved'), annotation('todo')])

    const result = appendToQueue(queuePath, [annotation('also todo')])

    expect(result.written).toBe(1)
    expect(result.pending).toBe(2)
  })

  it('refuses to write over a corrupt queue, leaving the bytes untouched', () => {
    // That file may be the only copy of work the user has not resolved. Overwriting it to
    // make one request succeed trades their data for a green response.
    appendToQueue(queuePath, [annotation('precious')])
    const corrupt = '{"version":1,"items":[ TRUNCATED'
    writeFileSync(queuePath, corrupt)

    expect(() => appendToQueue(queuePath, [annotation('new')])).toThrow()
    expect(readFileSync(queuePath, 'utf8')).toBe(corrupt)
  })

  it('ends the file with a newline, because `cat` is a design goal', () => {
    appendToQueue(queuePath, [annotation('first')])

    expect(readFileSync(queuePath, 'utf8').endsWith('}\n')).toBe(true)
  })
})
