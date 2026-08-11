import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findGitRoot } from './git-root.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dogear-cli-root-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Create `dir/<...segments>` and return the full path. */
function makeDir(...segments: string[]): string {
  const path = join(dir, ...segments)
  mkdirSync(path, { recursive: true })
  return path
}

describe('findGitRoot', () => {
  it('finds a `.git` directory in the starting directory itself', () => {
    makeDir('.git')

    expect(findGitRoot(dir)).toBe(dir)
  })

  it('finds a `.git` FILE — worktrees and submodules write a gitdir pointer', () => {
    // The reason this file checks existence rather than isDirectory(). Missing a worktree
    // would send the hook looking for a queue in a directory nothing ever writes to.
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/else/.git/worktrees/wt\n')

    expect(findGitRoot(dir)).toBe(dir)
  })

  it('walks up from a package subdirectory — where a session is often opened', () => {
    // CLAUDE_PROJECT_DIR is wherever the user started Claude Code, which in a monorepo is
    // routinely a package rather than the repo. The dev server wrote at the git root.
    makeDir('.git')
    const packageDir = makeDir('packages', 'apps', 'admin')

    expect(findGitRoot(packageDir)).toBe(dir)
  })

  it('returns the NEAREST repository when one is nested inside another', () => {
    makeDir('.git')
    const inner = makeDir('vendor', 'plugin')
    mkdirSync(join(inner, '.git'))

    expect(findGitRoot(join(inner, 'src'))).toBe(inner)
  })

  it('returns undefined outside a repository rather than guessing a fallback', () => {
    // The temp dir has no .git anywhere above it on any runner we support. If this fails
    // locally it means someone ran `git init` in their temp directory.
    expect(findGitRoot(makeDir('nested', 'deeper'))).toBeUndefined()
  })

  it('terminates at the filesystem root instead of looping', () => {
    // dirname() is a fixed point at the root on both platforms — '/' on POSIX, 'C:\\' on
    // Windows. A loop guard comparing against a hardcoded '/' would spin forever here.
    expect(findGitRoot(makeDir('a', 'b', 'c', 'd', 'e'))).toBeUndefined()
  })

  it('normalises a non-canonical path before walking', () => {
    makeDir('.git')
    makeDir('packages')

    // Built by concatenation, not join(), which would collapse the '..' itself and leave
    // nothing for resolve() to do.
    const messy = `${dir}${sep}packages${sep}..${sep}packages`

    expect(findGitRoot(messy)).toBe(dir)
  })
})
