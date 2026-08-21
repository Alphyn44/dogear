import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Annotation } from 'dogear-queue'
import {
  appendToQueue,
  queuePathFor,
  readQueue,
  resolveInQueue,
  stampAnnotation,
} from 'dogear-queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { prune } from './prune.js'
import { prune as pruneTool } from './tools.js'

/**
 * `dogear prune` — D6 (#25).
 *
 * The operation itself is `pruneQueue`, and `dogear-queue`'s queue.write.test.ts already
 * covers what it does to the file: resolved items go, pending ones stay, unknown statuses
 * survive, a corrupt queue is refused, and nothing is written when nothing changed. None of
 * that is re-asserted here except where it passes through the *command* — this file is about
 * the three things only the command decides: which repo, what the user reads, and the exit
 * code.
 *
 * **Every root is a temp directory, and that is not merely hygiene.** `run()` reads
 * `process.cwd()` directly, so a test that went through argv would prune the queue of the repo
 * the suite is running in — deleting the developer's own resolved annotations on every
 * `npm test`. `prune()` takes `cwd` as a parameter for exactly this reason; see the comment at
 * its call site in ./run.ts.
 */

let root: string

beforeEach(() => {
  root = makeRepo('dogear-prune-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A temp directory that looks like a git root. `.git` as a directory, as findGitRoot allows. */
function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, '.git'))
  return dir
}

/**
 * Seed through the real write path — `stampAnnotation` then `appendToQueue`, the two calls the
 * Vite endpoint makes — and resolve through `resolveInQueue`, the one the MCP tool makes.
 *
 * Hand-writing `{ status: 'resolved' }` would seed a shape the resolve path never produces: it
 * also stamps `resolvedAt`, and an item pruned by status alone would pass a test that a real
 * queue could still fail. Same argument as ./agreement.test.ts's fixtures.
 */
function seed(dir: string, ...items: readonly (readonly [string, boolean])[]): void {
  const annotations = items.map(([comment]) => stampAnnotation({ comment }))
  appendToQueue(queuePathFor(dir), annotations)

  const done = annotations
    .filter((_, index) => items[index]?.[1] === true)
    .map((annotation) => annotation.id)

  if (done.length > 0) resolveInQueue(queuePathFor(dir), done)
}

function commentsIn(dir: string): readonly string[] {
  return readQueue(queuePathFor(dir)).items.map((item) => item.comment)
}

describe('prune()', () => {
  it('drops the resolved items and leaves the pending ones', () => {
    seed(root, ['done', true], ['still open', false], ['also done', true])

    const result = prune(root)

    expect(result.exitCode).toBe(0)
    expect(commentsIn(root)).toEqual(['still open'])
  })

  it.each([
    {
      why: 'both counts plural',
      queue: [
        ['done', true],
        ['also done', true],
        ['a', false],
        ['b', false],
      ] as const,
      output: 'Pruned 2 resolved annotations. 2 annotations still pending.',
    },
    {
      why: 'both counts singular',
      queue: [
        ['done', true],
        ['a', false],
      ] as const,
      output: 'Pruned 1 resolved annotation. 1 annotation still pending.',
    },
    {
      why: 'nothing left pending — the queue is now empty',
      queue: [['done', true]] as const,
      output: 'Pruned 1 resolved annotation. 0 annotations still pending.',
    },
  ])('reports the count and what is left — $why', ({ queue, output }) => {
    seed(root, ...queue)

    expect(prune(root)).toEqual({ output, exitCode: 0 })
  })

  it('says so, and exits 0, when there is nothing to prune', () => {
    // Not an error: the queue is already in the state the user asked for. A non-zero exit
    // would make `dogear prune && something` unusable in the common case.
    seed(root, ['pending', false])

    expect(prune(root)).toEqual({
      output: 'Nothing to prune — no resolved annotations in the queue.',
      exitCode: 0,
    })
  })

  it('speaks with the MCP tool’s voice EXACTLY, over an identical queue', () => {
    // The anti-drift assertion, and the reason it needs two roots: `pruneTool` performs the
    // prune, so running both against one queue would compare a real prune to a no-op. Two
    // repos seeded identically is the only way to ask whether the sentences match.
    const other = makeRepo('dogear-prune-mcp-')
    try {
      seed(root, ['done', true], ['open', false])
      seed(other, ['done', true], ['open', false])

      expect(prune(root).output).toBe(pruneTool(other).text)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('does not CREATE the queue for a repo that has never used dogear', () => {
    // `dogear prune` in a fresh clone should be a no-op that leaves no trace, not a command
    // that writes an empty `.dogear/` to say there was nothing in it.
    const result = prune(root)

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Nothing to prune')
    expect(existsSync(dirname(queuePathFor(root)))).toBe(false)
  })

  it('resolves the queue from the GIT ROOT, not the directory it was run in', () => {
    // One repo is one queue. Someone standing in a package subdirectory of a monorepo must
    // prune the same file the dev server at the root wrote.
    seed(root, ['done', true])
    const deep = join(root, 'packages', 'admin', 'src')
    mkdirSync(deep, { recursive: true })

    expect(prune(deep).exitCode).toBe(0)
    expect(commentsIn(root)).toEqual([])
  })

  it('exits 1 outside a git repository, naming the directory', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'dogear-prune-nogit-'))
    try {
      const result = prune(orphan)

      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('no git repository')
      expect(result.output).toContain(orphan)
    } finally {
      rmSync(orphan, { recursive: true, force: true })
    }
  })

  it('exits 1 on a corrupt queue and leaves every byte of it alone', () => {
    // The assertion that matters. `pruneQueue` reads strictly and throws rather than writing
    // back what it could not parse; a prune that truncated a hand-broken file would destroy
    // the only copy of work nobody has resolved yet.
    const corrupt = '{"version":1,"items":[ TRUNCATED'
    seed(root, ['precious', false])
    writeFileSync(queuePathFor(root), corrupt, 'utf8')

    const result = prune(root)

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('dogear:')
    expect(readFileSync(queuePathFor(root), 'utf8')).toBe(corrupt)
  })

  it('exits 1 on a queue from a FUTURE schema version, rather than rewriting it', () => {
    // The other strict-read refusal, and the more dangerous one: this file parses cleanly, so
    // a tolerant reader would happily write back a version it does not understand.
    const future = JSON.stringify({ version: 99, updatedAt: null, items: [] })
    seed(root, ['whatever', false])
    writeFileSync(queuePathFor(root), future, 'utf8')

    expect(prune(root).exitCode).toBe(1)
    expect(readFileSync(queuePathFor(root), 'utf8')).toBe(future)
  })

  it.each([
    { why: 'an unknown status', status: 'archived' },
    { why: 'a status this build once had', status: 'stale' },
  ])('KEEPS $why through the command, not just at the queue layer', ({ status }) => {
    // Pinned here as well as in queue.write.test.ts because the command is what a user
    // actually runs, and "prune deleted something I did not recognise" is the one failure this
    // ticket must not be able to cause.
    appendToQueue(queuePathFor(root), [
      { ...stampAnnotation({ comment: 'odd' }), status } as Annotation,
    ])

    expect(prune(root).exitCode).toBe(0)
    expect(commentsIn(root)).toEqual(['odd'])
  })
})
