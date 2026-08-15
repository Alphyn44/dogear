import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isIgnored, isTracked } from './git.js'
import { createRepo, isolateGitConfig, removeRepo, trackFile } from './test-repo.js'

/**
 * The two questions only git can answer — E4 (#29).
 *
 * Small, and worth having anyway: every branch in ./gitignore.ts hangs off the mapping from
 * an exit code to `true`, `false` or `undefined`, and getting `check-ignore`'s 0-means-ignored
 * backwards would leave a repository's queue committable while every string assertion
 * elsewhere still passed.
 *
 * **The `undefined` cases are the ones with teeth.** They are what a machine without git, or a
 * worktree whose `gitdir:` pointer has gone stale, produces — and reading either as "yes,
 * ignored" is how the queue silently ends up in a commit.
 */

let root: string
let restoreGitConfig: () => void

beforeEach(() => {
  restoreGitConfig = isolateGitConfig()
  root = createRepo('dogear-git-')
})

afterEach(() => {
  removeRepo(root)
  restoreGitConfig()
})

describe('isIgnored()', () => {
  it('is true for a path an existing rule covers', () => {
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')

    expect(isIgnored(root, 'ignored.txt')).toBe(true)
  })

  it('is false for a path nothing covers', () => {
    expect(isIgnored(root, 'kept.txt')).toBe(false)
  })

  it('honours a negation, which is why this is not a line match', () => {
    // The case that makes parsing `.gitignore` by hand a losing game: the second rule wins,
    // and precedence runs bottom-up within a file.
    writeFileSync(join(root, '.gitignore'), '.dogear/*\n!.dogear/config.json\n')

    expect(isIgnored(root, '.dogear/queue.json')).toBe(true)
    expect(isIgnored(root, '.dogear/config.json')).toBe(false)
  })

  it('is undefined outside a repository, never false', () => {
    // 128, not 1. A caller that collapsed the two would conclude "not ignored" from "git
    // could not tell you" — true here by luck, and wrong wherever git is simply missing.
    const notARepo = mkdtempSync(join(tmpdir(), 'dogear-not-a-repo-'))

    try {
      expect(isIgnored(notARepo, 'anything.txt')).toBeUndefined()
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })
})

describe('isTracked()', () => {
  it('is true for a staged path', () => {
    // Staged, not committed: the index is what an ignore rule cannot override, and staging
    // is enough to get there without a `user.email` in an isolated config.
    mkdirSync(join(root, '.dogear'))
    writeFileSync(join(root, '.dogear/queue.json'), '{}')
    trackFile(root, '.dogear/queue.json')

    expect(isTracked(root, '.dogear/queue.json')).toBe(true)
  })

  it('is false for a file git has never seen', () => {
    writeFileSync(join(root, 'untracked.txt'), '')

    expect(isTracked(root, 'untracked.txt')).toBe(false)
  })

  it('is false for a path that does not exist at all', () => {
    expect(isTracked(root, 'nothing-here.txt')).toBe(false)
  })

  it('is undefined outside a repository', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'dogear-not-a-repo-'))

    try {
      expect(isTracked(notARepo, 'anything.txt')).toBeUndefined()
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })
})
