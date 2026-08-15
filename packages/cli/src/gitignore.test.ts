import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { QUEUE_DIR } from '@dogear/queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GitQueries } from './git.js'
import { isIgnored } from './git.js'
import { createGitignoreStep, gitignore } from './gitignore.js'
import type { Plan, Step } from './scaffold.js'
import { createRepo, isolateGitConfig, removeRepo, trackFile } from './test-repo.js'

/**
 * The `.gitignore` step — E4 (#29).
 *
 * Two acceptance criteria, and the first one is not a claim about the *text* of
 * `.gitignore`: `.dogear/queue.json` and `.dogear/*.tmp` are **ignored**, `config.json` is
 * **not**. So the assertions that matter ask real git the same question the step asks, after
 * the step has run, in a real repository. A test that only compared strings would pass on a
 * block written into a file git never consults.
 *
 * The second criterion — an existing file is appended to, never rewritten — is asserted on
 * the bytes, because "never rewritten" is a statement about someone else's content.
 */

const QUEUE_RULE = `${QUEUE_DIR}/queue.json`
const TEMP_RULE = `${QUEUE_DIR}/*.tmp`
const CONFIG_PATH = `${QUEUE_DIR}/config.json`

let root: string
let restoreGitConfig: () => void

beforeEach(() => {
  restoreGitConfig = isolateGitConfig()
  root = createRepo('dogear-gitignore-')
})

afterEach(() => {
  removeRepo(root)
  restoreGitConfig()
})

function ignorePath(): string {
  return join(root, '.gitignore')
}

function read(): string {
  return readFileSync(ignorePath(), 'utf8')
}

/** Plan, apply if there is anything to apply, and hand back what was planned. */
function runStep(step: Step = gitignore): Plan | undefined {
  const plan = step.plan(root)
  plan?.change?.apply()
  return plan
}

describe('the gitignore step on a repository with no .gitignore', () => {
  it('creates one and says so', () => {
    const plan = runStep()

    expect(plan?.change?.summary).toBe('created .gitignore')
    expect(read()).toBe(
      '# dogear — the queue is machine state; config.json is committed\n' +
        `${QUEUE_RULE}\n${TEMP_RULE}\n`,
    )
  })

  it('leaves git actually ignoring the queue and the temp files', () => {
    // The acceptance criterion, asked of the only authority on it. `.tmp` is checked
    // through a name `writeQueue` would really produce — `queue.json.<pid>.tmp` — rather
    // than a bare `x.tmp`, because the rule has to survive the two dots.
    runStep()

    expect(isIgnored(root, QUEUE_RULE)).toBe(true)
    expect(isIgnored(root, `${QUEUE_DIR}/queue.json.4242.tmp`)).toBe(true)
  })

  it('leaves config.json committable', () => {
    // The other half of the same criterion, and the reason `.dogear/` wholesale is wrong.
    runStep()

    expect(isIgnored(root, CONFIG_PATH)).toBe(false)
  })

  it('has nothing to do on the second run', () => {
    runStep()

    expect(runStep()).toBeUndefined()
  })
})

describe('the gitignore step on a repository that already has a .gitignore', () => {
  it('appends, and does not disturb what was there', () => {
    const existing = 'node_modules/\ndist/\n'
    writeFileSync(ignorePath(), existing)

    const plan = runStep()

    expect(plan?.change?.summary).toBe('updated .gitignore')
    expect(read().startsWith(existing)).toBe(true)
    expect(read()).toContain(QUEUE_RULE)
  })

  it('separates its block with one blank line', () => {
    writeFileSync(ignorePath(), 'node_modules/\n')

    runStep()

    expect(read()).toBe(
      'node_modules/\n\n# dogear — the queue is machine state; config.json is committed\n' +
        `${QUEUE_RULE}\n${TEMP_RULE}\n`,
    )
  })

  it('terminates a file that did not end in a newline', () => {
    // The failure this prevents is silent and total: `dist/# dogear …` is one line, so the
    // user's last rule and dogear's comment both stop being rules.
    writeFileSync(ignorePath(), 'node_modules/\ndist/')

    runStep()

    expect(read()).toContain('dist/\n')
    expect(read()).not.toContain('dist/#')
    expect(isIgnored(root, QUEUE_RULE)).toBe(true)
  })

  it('does not add a second blank line to a file that ends in one', () => {
    writeFileSync(ignorePath(), 'node_modules/\n\n')

    runStep()

    expect(read()).toBe(
      'node_modules/\n\n# dogear — the queue is machine state; config.json is committed\n' +
        `${QUEUE_RULE}\n${TEMP_RULE}\n`,
    )
  })

  it('does nothing at all when a broader rule already ignores the queue', () => {
    // What this repository's own .gitignore does. The step must not append two redundant
    // rules to it — which is the whole reason it asks git instead of matching lines.
    const existing = `${QUEUE_DIR}/*\n!${CONFIG_PATH}\n`
    writeFileSync(ignorePath(), existing)

    const plan = runStep()

    expect(plan?.change).toBeUndefined()
    expect(read()).toBe(existing)
  })
})

describe('the notes the gitignore step reports', () => {
  it('says so when an existing rule swallows config.json', () => {
    // `.dogear/` with no negation: the queue is ignored, so there is nothing to append, and
    // config.json is ignored too, which init cannot fix by appending anything.
    writeFileSync(ignorePath(), `${QUEUE_DIR}/\n`)

    const plan = runStep()

    expect(plan?.change).toBeUndefined()
    expect(plan?.notes?.join('\n')).toContain(CONFIG_PATH)
    expect(plan?.notes?.join('\n')).toContain('will not be committed')
  })

  it('is silent about config.json when it is committable', () => {
    expect(runStep()?.notes ?? []).toEqual([])
  })

  it('says so when the queue is already tracked, and names the fix', () => {
    // An ignore rule has no effect on a file in the index, so this is the case where the
    // criterion is met and the queue still gets committed on every push.
    mkdirSync(join(root, QUEUE_DIR))
    writeFileSync(join(root, QUEUE_DIR, 'queue.json'), '{"version":1,"items":[]}')
    trackFile(root, QUEUE_RULE)

    const notes = runStep()?.notes?.join('\n') ?? ''

    expect(notes).toContain('already tracked by git')
    expect(notes).toContain(`git rm --cached ${QUEUE_RULE}`)
  })

  it('still appends the rules when the queue is tracked', () => {
    // The note is advice, not a refusal — a `git rm --cached` later should find the rule
    // already in place rather than needing a second init.
    mkdirSync(join(root, QUEUE_DIR))
    writeFileSync(join(root, QUEUE_DIR, 'queue.json'), '{"version":1,"items":[]}')
    trackFile(root, QUEUE_RULE)

    runStep()

    expect(read()).toContain(QUEUE_RULE)
  })
})

describe('the gitignore step when git cannot answer', () => {
  /** No git on PATH, a `.cmd` shim, a worktree pointing at a gitdir that is gone. */
  const blind: GitQueries = { isIgnored: () => undefined, isTracked: () => undefined }
  const step = createGitignoreStep(blind)

  it('writes the rules rather than assuming they are there', () => {
    // The asymmetry, stated: a redundant rule costs a line, an unignored queue gets
    // committed.
    runStep(step)

    expect(read()).toContain(QUEUE_RULE)
  })

  it('does NOT append them a second time', () => {
    // The regression this guards is a `.gitignore` that grows by three lines on every
    // single run — idempotency cannot depend on the answer git just failed to give.
    runStep(step)
    const after = read()

    expect(runStep(step)).toBeUndefined()
    expect(read()).toBe(after)
  })

  it('reports no notes, since it knows nothing to report', () => {
    expect(runStep(step)?.notes ?? []).toEqual([])
  })
})

describe('the gitignore step when .gitignore is not a regular file', () => {
  beforeEach(() => {
    mkdirSync(ignorePath())
  })

  it('plans a change rather than throwing during planning', () => {
    // Planning runs for every step before any of them applies, so a throw here takes down
    // the whole report — including the steps that had something useful to say.
    expect(() => gitignore.plan(root)).not.toThrow()
  })

  it('fails on apply, naming the path and the way out', () => {
    const change = gitignore.plan(root)?.change

    expect(() => change?.apply()).toThrow(/\.gitignore exists at/)
    expect(() => change?.apply()).toThrow(/Remove it and re-run/)
  })
})
