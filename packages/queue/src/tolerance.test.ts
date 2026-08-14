import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { queuePathFor, readQueue, tryReadQueue } from './queue.js'

/**
 * The relationship between the two readers.
 *
 * This replaces `packages/cli/src/parity.test.ts`, which compared the CLI's reader against
 * `@dogear/vite`'s copy and failed if they ever drifted. D1 merged the copies into one
 * module, so most of that file became vacuous — it would have been comparing a module to
 * itself. The guarantee it protected did not go away with it, though. It changed shape:
 *
 * - Then: two implementations must agree about *where* the queue is and *what a healthy one
 *   means*, and may differ only on corruption.
 * - Now: one implementation, two entry points, which must agree on every healthy file and
 *   diverge only on a corrupt one — because that divergence is the whole reason both exist.
 *
 * The last test below is the one that matters most, and it could not be written before: the
 * tolerant reader *drops* malformed entries, so feeding its result to a writer would delete
 * them. That is why `readQueue` is the reader every writer uses, and why this file states it
 * as an executable claim rather than a comment.
 */

let root: string
let queuePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-tolerance-'))
  queuePath = queuePathFor(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeRaw(contents: string): void {
  mkdirSync(dirname(queuePath), { recursive: true })
  writeFileSync(queuePath, contents)
}

describe('readQueue and tryReadQueue', () => {
  it('return the same items for a well-formed queue', () => {
    const items = [
      { id: 'a', status: 'pending', comment: 'first' },
      { id: 'b', status: 'resolved', comment: 'second' },
    ]
    writeRaw(`${JSON.stringify({ version: 1, updatedAt: null, items }, null, 2)}\n`)

    const tolerant = tryReadQueue(queuePath)

    expect(tolerant).toEqual({ ok: true, items })
    expect(tolerant.ok && tolerant.items).toEqual(readQueue(queuePath).items)
  })

  it('both treat a missing queue as empty — the first annotation is not an error', () => {
    expect(tryReadQueue(queuePath)).toEqual({ ok: true, items: [] })
    expect(readQueue(queuePath).items).toEqual([])
  })

  it('diverge ONLY on a corrupt queue — the strict one throws, the tolerant one must not', () => {
    // This asymmetry is the reason both exist. A writer needs the throw so it can refuse
    // and leave the bytes alone; the hook needs the silence or it destroys the prompt the
    // user typed. If someone ever "simplifies" this to one reader, one of these two
    // expectations breaks and says which half they broke.
    writeRaw('{"version":1,"items":[')

    expect(() => readQueue(queuePath)).toThrow()
    expect(tryReadQueue(queuePath).ok).toBe(false)
  })

  it('report the same path in the failure, since the reason is the developer’s only clue', () => {
    writeRaw('{"version":99,"items":[]}')

    const tolerant = tryReadQueue(queuePath)

    expect(tolerant.ok).toBe(false)
    expect(tolerant.ok || tolerant.reason).toContain(queuePath)
    expect(() => readQueue(queuePath)).toThrow(queuePath)
  })

  it('DROPS a malformed entry where the strict reader keeps the file whole — which is why the tolerant result must never be written back', () => {
    // The claim the old parity test could not make. `tryReadQueue` returns two items for a
    // file that has three; handing that array to `writeQueue` would delete the third, and
    // the caller would see a perfectly successful write. Every writer therefore uses
    // `readQueue`, which refuses this file outright.
    const good = { id: 'a', status: 'pending', comment: 'keep me' }
    const alsoGood = { id: 'b', status: 'pending', comment: 'keep me too' }
    const broken = { status: 'pending', comment: 'no id, hand-edited' }
    writeRaw(
      JSON.stringify({ version: 1, updatedAt: null, items: [good, broken, alsoGood] }),
    )

    const tolerant = tryReadQueue(queuePath)

    expect(tolerant).toEqual({ ok: true, items: [good, alsoGood] })
    expect(readQueue(queuePath).items).toHaveLength(3)
  })
})
