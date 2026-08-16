import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

  // A Vite repository, since E2 (#27): detection runs on every invocation and a repo with no
  // Vite config earns a `note:`, which suppresses `nothing changed` — so a bare temp directory
  // would quietly stop exercising E1's third criterion. ./detect.test.ts owns the shapes
  // detection can see; this file needs one that produces a clean report.
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      devDependencies: { vite: '^8.2.1' },
      dependencies: { react: '^19.2.0' },
    }),
  )
  writeFileSync(join(root, 'vite.config.ts'), '')
})

afterEach(() => {
  removeRepo(root)
  restoreGitConfig()
})

/** The report's first line, which names the root init actually resolved. */
function header(): string {
  return `dogear: ${root}`
}

/**
 * E2's detection lines for the fixture above, indented as the report indents them.
 *
 * Spelled out rather than matched loosely, because they now sit between the header and every
 * change line — a suite that skipped past them would stop noticing if they moved.
 */
const FINDINGS = [
  '  vite:      vite.config.ts (vite ^8.2.1)',
  '  framework: react ^19.2.0',
  '  workspace: single package, 1 app',
]

/**
 * E8's trailing block for the same fixture, which declares no `@dogear/vite` — unindented,
 * because the snippet's own leading whitespace is content the user copies.
 *
 * Every whole-output assertion carries it. That is the point of spelling it out rather than
 * trimming it off: this block is the last thing the command prints and the only part of the
 * output the user is meant to act on, so a change to it should fail the cases that pin the
 * shape of the whole report.
 */
const BLOCK = [
  '',
  'add dogear to vite.config.ts:',
  '',
  "  import { dogear } from '@dogear/vite'",
  '',
  '  export default defineConfig({',
  '    plugins: [dogear()],',
  '  })',
  '',
  'then, at the repo root: npm i -D @dogear/vite',
]

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
        ...FINDINGS,
        `  created ${QUEUE_DIR}/`,
        `  created ${QUEUE_DIR}/${CONFIG_FILE}`,
        '  created .gitignore',
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
      [header(), ...FINDINGS, '  nothing changed', ...BLOCK].join('\n'),
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
    expect(
      scaffold(root)
        .output.split('\n')
        .slice(1, 1 + FINDINGS.length),
    ).toEqual(FINDINGS)
  })
})

describe('scaffold() reporting what it detected', () => {
  it('says so plainly when there is no vite config, and still sets the repo up', () => {
    // Reported, not refused. Detection is a guess, and a guess that blocked init would turn a
    // repository with an unusual config filename into one dogear cannot be installed in.
    // Everything init writes is inert without Vite, and E3's MCP wiring is not.
    rmSync(join(root, 'vite.config.ts'))

    const result = scaffold(root)

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('vite:      none found')
    expect(result.output).toContain('note: no vite config found')
    expect(existsSync(join(root, QUEUE_DIR))).toBe(true)
  })

  it('still gives a verdict on a re-run of a repo with no vite config', () => {
    // Detection's remarks do not suppress `nothing changed`, unlike a step's notes. Without
    // that split, the commonest reason to run init twice is also the case where it never says
    // whether it did anything — which ../test-built/init.test.ts caught first.
    rmSync(join(root, 'vite.config.ts'))
    scaffold(root)

    const again = scaffold(root)

    expect(again.output).toContain('nothing changed')
    expect(again.output).toContain('note: no vite config found')
  })

  it('names each app in a monorepo, because their frameworks differ', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'], devDependencies: { vite: '^8.2.1' } }),
    )
    rmSync(join(root, 'vite.config.ts'))
    for (const [name, dep] of [
      ['web', { react: '^19.2.0' }],
      ['admin', { vue: '^3.5.0' }],
    ] as const) {
      mkdirSync(join(root, 'packages', name), { recursive: true })
      writeFileSync(
        join(root, 'packages', name, 'package.json'),
        JSON.stringify({ dependencies: dep }),
      )
      writeFileSync(join(root, 'packages', name, 'vite.config.ts'), '')
    }

    const output = scaffold(root).output

    expect(output).toContain('apps:      packages/admin — vue ^3.5.0 (vite.config.ts)')
    expect(output).toContain('           packages/web — react ^19.2.0 (vite.config.ts)')
    expect(output).toContain('workspace: npm workspaces, 2 packages, 2 apps')
  })

  it('warns that a non-JSX app gets the selector floor, and only about that app', () => {
    // brief:1517 — the transform is JSX-only, so a Vue app's annotations carry no exact source
    // location. Saying nothing would leave the user to discover that by using it.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.5.0' } }),
    )

    const output = scaffold(root).output

    expect(output).toContain('note: . (vue) — ')
    expect(output).toContain('JSX-only')
  })

  it('says nothing about the transform for a React app', () => {
    expect(scaffold(root).output).not.toContain('JSX-only')
  })
})

describe('scaffold() telling the user to install the plugin', () => {
  /** The fixture above has a vite config and no `@dogear/vite`, so the block is expected. */
  const HEADING = 'add dogear to vite.config.ts:'

  it('prints the snippet and the install command below the report', () => {
    const lines = scaffold(root).output.split('\n')
    const at = lines.indexOf(HEADING)

    expect(at).toBeGreaterThan(0)
    expect(lines.indexOf('  created .gitignore')).toBeLessThan(at)
  })

  it('separates the block from the report with a blank line', () => {
    const lines = scaffold(root).output.split('\n')

    expect(lines[lines.indexOf(HEADING) - 1]).toBe('')
  })

  it('leaves the block OUTSIDE the report’s indent', () => {
    // Not cosmetic. The two-space indent belongs to the one-line-per-item body, and the snippet
    // carries an indent of its own that the body's would corrupt — this is text the user copies
    // into a config file, so the leading whitespace is content.
    const output = scaffold(root).output

    expect(output).toContain("\n  import { dogear } from '@dogear/vite'")
    expect(output).not.toContain("\n    import { dogear } from '@dogear/vite'")
  })

  it('writes nothing to say it — the manifest is untouched', () => {
    // E8's whole decision. init prints the dependency rather than adding it: no range resolves
    // while the packages are unpublished, and a manifest edited without a lockfile update fails
    // the next `npm ci`.
    const before = readFileSync(join(root, 'package.json'), 'utf8')

    scaffold(root)

    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  })

  it('says nothing once the plugin is declared', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.2.1', '@dogear/vite': '^1.0.0' } }),
    )

    expect(scaffold(root).output).not.toContain('add dogear to')
  })

  it('reports a runtime dependency as the leak it is, and does not move it', () => {
    // The manifest half of what scripts/check-leak.ts catches: a dev-only plugin in
    // `dependencies` installs in production even when every bundle is clean.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@dogear/vite': '^1.0.0' } }),
    )

    const output = scaffold(root).output

    expect(output).toContain('note: @dogear/vite is a runtime dependency')
    expect(output).toContain('devDependencies')
    // Declared is declared — the import resolves, so it is not also told to install it.
    expect(output).not.toContain('add dogear to')
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({
      dependencies: { '@dogear/vite': '^1.0.0' },
    })
  })

  it('withholds the block when a step failed', () => {
    // Telling someone to install a plugin into a repository init could not finish setting up
    // buries the thing they actually need to act on. The re-run prints it.
    writeFileSync(join(root, QUEUE_DIR), 'not a directory')

    const result = scaffold(root)

    expect(result.exitCode).toBe(1)
    expect(result.output).not.toContain('add dogear to')
  })

  it('says nothing at all when the repo has no vite config', () => {
    rmSync(join(root, 'vite.config.ts'))

    expect(scaffold(root).output).not.toContain('add dogear to')
  })
})

describe('scaffold() with dryRun', () => {
  it('writes NOTHING, on a repository where a real run would write three things', () => {
    // The whole contract. Every `plan()` runs and no `apply()` does, which is only safe
    // because planning never writes — see the header of ./scaffold.ts.
    scaffold(root, { dryRun: true })

    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
  })

  it('marks itself and puts the changes in the conditional', () => {
    expect(scaffold(root, { dryRun: true }).output).toBe(
      [
        header(),
        '  dry run — nothing was written',
        ...FINDINGS,
        `  would create ${QUEUE_DIR}/`,
        `  would create ${QUEUE_DIR}/${CONFIG_FILE}`,
        '  would create .gitignore',
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
