import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The one place in this package allowed to reach into another package's source. Test files
// are not a tsup entry and are excluded from declaration emit, so the boundary that keeps
// src/ from importing across packages does not apply here — and going through the package
// name would resolve to vite's dist/ and make `npm run typecheck` depend on a build.
// See ./queue.ts and ./git-root.ts for why these are copies at all.
import { findGitRoot as findGitRootInVite } from '../../vite/src/git-root.js'
import {
  QUEUE_DIR as QUEUE_DIR_IN_VITE,
  QUEUE_VERSION as QUEUE_VERSION_IN_VITE,
  queuePathFor as queuePathForInVite,
  readQueue as readQueueInVite,
} from '../../vite/src/queue.js'
import { findGitRoot } from './git-root.js'
import { QUEUE_DIR, QUEUE_VERSION, queuePathFor, readQueue } from './queue.js'

/**
 * The writer lives in `@dogear/vite`, the reader lives here, and they are separate files on
 * purpose: the plugin must throw on a corrupt queue so its endpoint can answer 500 and leave
 * the bytes alone, while the hook must swallow everything and exit 0 or it destroys the
 * prompt the user typed.
 *
 * What they may never disagree on is *where* the queue is and *what a healthy one means*. A
 * drift there is silent — the plugin writes somewhere the hook never looks, or the hook
 * reports an empty queue for a file that has items in it — and nothing else in the test
 * suite would notice. This file is the guard, mirroring the one that protects the leak
 * sentinel's duplicate in `packages/vite/src/sentinel.test.ts`.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-parity-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the queue reader in @dogear/cli', () => {
  it('agrees with @dogear/vite on the queue directory and schema version', () => {
    expect(QUEUE_DIR).toBe(QUEUE_DIR_IN_VITE)
    expect(QUEUE_VERSION).toBe(QUEUE_VERSION_IN_VITE)
  })

  it('resolves the same queue path the plugin writes to', () => {
    // Drift here means the dev server writes a file the hook never opens, and neither half
    // reports anything wrong.
    expect(queuePathFor(root)).toBe(queuePathForInVite(root))
  })

  it('reads back exactly the items the plugin’s queue shape holds', () => {
    const items = [
      { id: 'a', status: 'pending', comment: 'first' },
      { id: 'b', status: 'resolved', comment: 'second' },
    ]
    const queuePath = queuePathFor(root)
    mkdirSync(dirname(queuePath), { recursive: true })
    writeFileSync(
      queuePath,
      `${JSON.stringify({ version: QUEUE_VERSION, updatedAt: null, items }, null, 2)}\n`,
    )

    const here = readQueue(queuePath)

    expect(here).toEqual({ ok: true, items })
    expect(here.ok && here.items).toEqual(readQueueInVite(queuePath).items)
  })

  it('treats a missing queue as empty, exactly as the plugin does', () => {
    const queuePath = queuePathFor(root)

    expect(readQueue(queuePath)).toEqual({ ok: true, items: [] })
    expect(readQueueInVite(queuePath).items).toEqual([])
  })

  it('diverges ONLY on a corrupt queue — the plugin throws, the hook must not', () => {
    // This asymmetry is the reason the two files exist separately. If someone ever
    // "fixes" it by sharing one implementation, one of these two expectations breaks and
    // says which half they broke.
    const queuePath = queuePathFor(root)
    mkdirSync(dirname(queuePath), { recursive: true })
    writeFileSync(queuePath, '{"version":1,"items":[')

    expect(() => readQueueInVite(queuePath)).toThrow()
    expect(readQueue(queuePath).ok).toBe(false)
  })
})

describe('the git-root walk in @dogear/cli', () => {
  it.each([
    { why: 'the repo root itself', segments: [] },
    { why: 'a package subdirectory', segments: ['packages', 'apps', 'admin'] },
    { why: 'a directory that does not exist on disk', segments: ['not', 'created'] },
  ])('finds the same root as @dogear/vite from $why', ({ segments }) => {
    mkdirSync(join(root, '.git'))
    const start = join(root, ...segments)

    expect(findGitRoot(start)).toBe(findGitRootInVite(start))
    expect(findGitRoot(start)).toBe(root)
  })

  it('agrees that a directory outside a repository has no root', () => {
    expect(findGitRoot(root)).toBeUndefined()
    expect(findGitRootInVite(root)).toBeUndefined()
  })
})
