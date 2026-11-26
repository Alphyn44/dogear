import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_FILE, QUEUE_DIR } from 'dogear-queue'
import { beforeEach, describe, expect, it } from 'vitest'

import { CLI_ENTRY } from './detect.js'
import type { Wiring } from './scaffold.js'
import { scaffold, stepsFor, undoSteps } from './scaffold.js'
import { trackFile } from './test-repo.js'
import {
  BLOCK,
  findings,
  header,
  registryLabel,
  root,
  useScaffoldRepo,
  WIRING,
} from './test-scaffold.js'

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
 *
 * **What init says about a repository** is in ./scaffold.report.test.ts, and **how it wires
 * agents** is in ./scaffold.wiring.test.ts. The three were one file until #87, which split
 * them so they run on separate workers; ./test-scaffold.ts holds the fixture they share.
 */

useScaffoldRepo()

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

  it('indents changes under the header, in step order, below the findings', () => {
    // Order is asserted, not just membership: the config step writes inside the directory
    // the first step creates, and apply stops at the first failure. Since E2 the findings come
    // first — #27's second criterion is a claim about *order*, so this is where it is pinned.
    expect(scaffold(root).output).toBe(
      [
        header(),
        ...findings(),
        `  created ${QUEUE_DIR}/`,
        `  created ${QUEUE_DIR}/${CONFIG_FILE}`,
        // E3's three, in the brief's Delivery order: the MCP baseline, then the stanza that
        // gets it pulled, then the hook that is the tier on top.
        ...WIRING,
        '  created .gitignore',
        // E5 (#30), last: the only step that writes outside the repository, and the only one
        // whose work is not part of the feature itself.
        `  registered this repository in ${registryLabel()}`,
        ...BLOCK,
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
    //
    // The findings are here too, and that is E2's answer to a question #26 did not have to
    // ask: they describe the repository rather than the run, so they print whether or not
    // anything happened. `nothing changed` still follows, because it is still true and it is
    // the only line answering what the user actually asked. Findings do not suppress it; notes
    // do — see the block below.
    const again = scaffold(root)

    expect(again.exitCode).toBe(0)
    expect(again.output).toBe(
      // `claude code`, where the first run said `none detected` — the settings file init
      // itself wrote is now a marker. Every one of E3's three steps is silent here, which is
      // the third criterion holding across a step list that doubled in E3.
      [
        header(),
        ...findings('claude code (.claude/)'),
        '  nothing changed',
        ...BLOCK,
      ].join('\n'),
    )
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

  it('still reports what it found, above the failure', () => {
    // Detection ran before any step planned, so its findings survive a step that could not
    // apply — and they are exactly what someone diagnosing the failure wants to see.
    const expected = findings()

    expect(
      scaffold(root)
        .output.split('\n')
        .slice(1, 1 + expected.length),
    ).toEqual(expected)
  })
})

describe('scaffold() with dryRun', () => {
  it('writes NOTHING, on a repository where a real run would write three things', () => {
    // The whole contract. Every `plan()` runs and no `apply()` does, which is only safe
    // because planning never writes — see the header of ./scaffold.ts.
    scaffold(root, { dryRun: true })

    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
    // E3's three write outside `.dogear/`, which is exactly why they are worth naming here:
    // `--dry-run` is the only thing standing between a wrong agent guess and an edit to the
    // user's agent configuration.
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(root, '.claude'))).toBe(false)
  })

  it('marks itself and puts the changes in the conditional', () => {
    expect(scaffold(root, { dryRun: true }).output).toBe(
      [
        header(),
        '  dry run — nothing was written',
        ...findings(),
        `  would create ${QUEUE_DIR}/`,
        `  would create ${QUEUE_DIR}/${CONFIG_FILE}`,
        '  would register dogear in .mcp.json',
        '  would create AGENTS.md',
        '  would create .claude/settings.json',
        '  would create .gitignore',
        `  would register this repository in ${registryLabel()}`,
        ...BLOCK,
      ].join('\n'),
    )
  })

  it('renders every step’s verb in the imperative, including a step added later', () => {
    // The guard on ./scaffold.ts's IMPERATIVE table. A step whose summary opens with a verb
    // the table does not know renders unchanged, and `would created` is a typo that ships —
    // grammatical, invisible to typecheck, and only ever seen by whoever used the flag.
    for (const line of scaffold(root, { dryRun: true }).output.split('\n')) {
      if (line.includes('would ')) expect(line).not.toMatch(/would \w+ed\b/)
    }
  })

  it('exits 0 — a dry run that found work to do is not a failure', () => {
    expect(scaffold(root, { dryRun: true }).exitCode).toBe(0)
  })

  it('reports nothing changed on an already-initialized repo, same as a real run', () => {
    scaffold(root)

    expect(scaffold(root, { dryRun: true }).output).toContain('nothing changed')
  })

  it('prints the plugin block identically, because it was never a change', () => {
    // The block is guidance, not work. A dry run has nothing to withhold about it, so the two
    // outputs differ only by the marker line and the tense of the change lines.
    const dry = scaffold(root, { dryRun: true }).output
    const real = scaffold(root).output
    const block = (output: string): string =>
      output.slice(output.indexOf('\nadd dogear to'))

    expect(block(dry)).toBe(block(real))
  })

  it('leaves the repository in a state where the real run still does the work', () => {
    // The failure this guards: a dry run that half-applied would make the next real run report
    // less than it did, and the user would never learn what was skipped.
    scaffold(root, { dryRun: true })

    expect(scaffold(root).output).toContain(`created ${QUEUE_DIR}/`)
  })
})

describe('every step can be undone — E6 (#39)', () => {
  it('has an Undo for every Step, matched by name', () => {
    // **This is what a `revert` on `Step` would have given the compiler**, recovered as a test.
    // #39 weighed the two and the second list won on other grounds (see `Undo` in
    // ./scaffold.ts), which leaves nothing forcing a new step to declare a teardown. A step
    // added without one is a step that `dogear init --undo` silently walks past, leaving
    // exactly the residue the ticket exists to remove — so it fails here instead.
    const wiring: Wiring = {
      agents: ['claude', 'cursor', 'vscode'],
      hook: true,
      entry: CLI_ENTRY,
      withheld: [],
    }
    const undone = new Set(undoSteps().map((step) => step.name))

    for (const step of stepsFor(wiring)) {
      expect(undone).toContain(step.name)
    }
  })

  it('names nothing that is not a step', () => {
    // The other direction, which catches a rename on the init side: an `Undo` whose `Step` has
    // gone is reversing something nothing writes any more.
    const wiring: Wiring = {
      agents: ['claude', 'cursor', 'vscode'],
      hook: true,
      entry: CLI_ENTRY,
      withheld: [],
    }
    const steps = new Set(stepsFor(wiring).map((step) => step.name))

    for (const step of undoSteps()) {
      expect(steps).toContain(step.name)
    }
  })
})
