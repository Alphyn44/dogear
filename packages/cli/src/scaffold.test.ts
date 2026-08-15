import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_FILE, QUEUE_DIR } from '@dogear/queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scaffold } from './scaffold.js'
import { createRepo, isolateGitConfig, removeRepo, trackFile } from './test-repo.js'

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
 *
 * **The temp roots are real repositories since E4 (#29)**, because the gitignore step asks git
 * whether the queue is ignored and `scaffold()` is only ever handed a git root in the first
 * place. The individual steps are covered in ./queue-dir.ts's, ./config.ts's and
 * ./gitignore.ts's own suites; what is asserted here is the runner — ordering, the report, and
 * what happens when one of them fails.
 */

let root: string
let restoreGitConfig: () => void

beforeEach(() => {
  restoreGitConfig = isolateGitConfig()
  root = createRepo('dogear-scaffold-')
})

afterEach(() => {
  removeRepo(root)
  restoreGitConfig()
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

  it('indents changes under the header, in step order', () => {
    // Order is asserted, not just membership: the config step writes inside the directory
    // the first step creates, and apply stops at the first failure.
    expect(scaffold(root).output).toBe(
      [
        header(),
        `  created ${QUEUE_DIR}/`,
        `  created ${QUEUE_DIR}/${CONFIG_FILE}`,
        '  created .gitignore',
      ].join('\n'),
    )
  })

  it('does not claim nothing changed while also reporting a change', () => {
    expect(scaffold(root).output).not.toContain('nothing changed')
  })

  it('leaves the queue ignored and the config committable', () => {
    // E4's two criteria, end to end through the runner rather than through one step.
    scaffold(root)

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain(
      `${QUEUE_DIR}/queue.json`,
    )
    expect(JSON.parse(readFileSync(join(root, QUEUE_DIR, CONFIG_FILE), 'utf8'))).toEqual({
      version: 1,
    })
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

describe('scaffold() when a step has something to say', () => {
  beforeEach(() => {
    // A repo that ran a dev server before it ran init: the queue is in the index, where no
    // ignore rule can reach it. Staged *first*, in that order, because git refuses to add an
    // already-ignored path — which is the same sequence a real user hits.
    mkdirSync(join(root, QUEUE_DIR))
    writeFileSync(join(root, QUEUE_DIR, 'queue.json'), '{"version":1,"items":[]}')
    trackFile(root, `${QUEUE_DIR}/queue.json`)

    // Then a full init, so the cases below run against a repo with nothing left to change.
    scaffold(root)
  })

  it('prints the note, indented, after the changes', () => {
    const output = scaffold(root).output

    expect(output).toContain('  note: ')
    expect(output).toContain('git rm --cached')
  })

  it('does NOT say nothing changed, because something needs attention', () => {
    // Nothing did change — every step was satisfied. But a report whose summary line
    // contradicts its own body is worse than no summary, so notes suppress it.
    expect(scaffold(root).output).not.toContain('nothing changed')
  })

  it('still exits 0 — a note is not a failure', () => {
    expect(scaffold(root).exitCode).toBe(0)
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
