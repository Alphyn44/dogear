import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QUEUE_DIR } from '@dogear/queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scaffold } from './scaffold.js'

/**
 * What `dogear init` does to a repository, and what it says about it — E1 (#26).
 *
 * `scaffold()` takes its root as a parameter and returns bytes rather than writing them, so
 * every case here runs against a temp directory in the fast suite with no build and no
 * subprocess. ./init.test.ts covers the adapter that finds the root and puts the bytes on a
 * stream.
 *
 * **The idempotency cases are the point of the file.** #26's third criterion is that
 * re-running "reports only what changed", and the failure mode it guards against is not a
 * crash — it is an init that quietly rewrites something a user edited, or that reports work it
 * did not do. Both are silent, so both are asserted on the filesystem as well as on the text.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-scaffold-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The report's first line, which names the root init actually resolved. */
function header(): string {
  return `dogear: ${root}`
}

describe('scaffold() on a fresh repository', () => {
  it('creates .dogear/ and reports it', () => {
    const result = scaffold(root)

    expect(result.exitCode).toBe(0)
    expect(existsSync(join(root, QUEUE_DIR))).toBe(true)
    expect(statSync(join(root, QUEUE_DIR)).isDirectory()).toBe(true)
    expect(result.output).toContain(`created ${QUEUE_DIR}/`)
  })

  it('names the resolved root, not the directory the user was standing in', () => {
    // A monorepo user runs this from a package and the queue lands at the root. Printing the
    // root is what turns that from a surprise into information.
    expect(scaffold(root).output.startsWith(header())).toBe(true)
  })

  it('indents changes under the header', () => {
    expect(scaffold(root).output).toBe(`${header()}\n  created ${QUEUE_DIR}/`)
  })

  it('does not claim nothing changed while also reporting a change', () => {
    expect(scaffold(root).output).not.toContain('nothing changed')
  })
})

describe('scaffold() on an already-initialized repository', () => {
  beforeEach(() => {
    scaffold(root)
  })

  it('reports that nothing changed, and exits 0', () => {
    // Exit 0, not 1. "Already set up" is the state the user asked for; a non-zero exit would
    // make `dogear init && npm run dev` unusable for everyone past the first run.
    const again = scaffold(root)

    expect(again.exitCode).toBe(0)
    expect(again.output).toBe(`${header()}\n  nothing changed`)
  })

  it('reports NO change lines the second time', () => {
    // The literal reading of the third criterion. A step that reports itself unconditionally
    // is how the report stops meaning anything by E4, when six of them run every time.
    expect(scaffold(root).output).not.toContain('created')
  })

  it('leaves the contents of .dogear/ alone', () => {
    // The failure this exists to catch is an init that recreates the directory it found —
    // which by E4 would take a queue and a hand-edited config.json with it. Idempotency has
    // to be a property of the filesystem, not just of the wording.
    const queue = join(root, QUEUE_DIR, 'queue.json')
    writeFileSync(queue, '{"version":1,"updatedAt":null,"items":[]}')

    scaffold(root)

    expect(readFileSync(queue, 'utf8')).toBe('{"version":1,"updatedAt":null,"items":[]}')
  })

  it('is stable over repeated runs, not just the second one', () => {
    expect(scaffold(root).output).toBe(scaffold(root).output)
  })
})

describe('scaffold() when a step fails', () => {
  beforeEach(() => {
    // `.dogear` as a regular file. Contrived on purpose: it is the one failure this single
    // step can have that is not an environment problem, and it stands in for the class —
    // read-only checkouts, a permissions-managed directory — that E2–E4 will hit for real.
    writeFileSync(join(root, QUEUE_DIR), 'not a directory')
  })

  it('exits non-zero and says what failed', () => {
    const result = scaffold(root)

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('failed')
  })

  it('does NOT mistake an occupied path for a satisfied step', () => {
    // The regression this whole block was written for, and it caught a real bug: `existsSync`
    // is true for a regular file, so a step planning on existence alone returns `undefined`
    // and init reports `nothing changed` over a repository where no queue can ever be written.
    // Exit 0, no throw, a confident and wrong report — the worst shape a failure can take.
    // Every step E2–E4 adds inherits the trap: check for the state you need, not for the path
    // being occupied.
    expect(scaffold(root).exitCode).not.toBe(0)
  })

  it('names the offending path and the way out', () => {
    // A bare EEXIST would satisfy the exit code and tell the user nothing. `apply` re-checks
    // precisely so this message exists.
    const output = scaffold(root).output

    expect(output).toContain(QUEUE_DIR)
    expect(output).toContain('not a directory')
    expect(output).toContain('Remove it and re-run')
  })

  it('does NOT report the change it failed to make', () => {
    // `applied` holds what actually happened. A report that lists an intended change beside a
    // failure is how a user concludes the directory exists when it does not — and by E3, how
    // they conclude their agent is wired when it is not.
    expect(scaffold(root).output).not.toContain(`created ${QUEUE_DIR}/`)
  })

  it('still names the root, so the failure is attributable', () => {
    expect(scaffold(root).output.startsWith(header())).toBe(true)
  })

  it('does not report "nothing changed" when something went wrong', () => {
    // The empty-changes branch and the failure branch both produce zero applied lines. Reading
    // "nothing changed" after a failed init would be the worst possible summary of it.
    expect(scaffold(root).output).not.toContain('nothing changed')
  })
})
