import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findAppName } from './app-name.js'

/**
 * C4 (#18). The fixture shape that matters is a Vite root well below the git root, because
 * "the nearest package.json wins" is only meaningfully tested where there is more than one
 * candidate above the starting directory.
 */

let gitRoot: string

beforeEach(() => {
  gitRoot = mkdtempSync(join(tmpdir(), 'dogear-app-name-'))
})

afterEach(() => {
  rmSync(gitRoot, { recursive: true, force: true })
})

/** Create `<gitRoot>/<segments>` and return it. */
function dir(...segments: string[]): string {
  const path = join(gitRoot, ...segments)
  mkdirSync(path, { recursive: true })
  return path
}

function manifest(at: string, contents: string): void {
  writeFileSync(join(at, 'package.json'), contents)
}

describe('findAppName', () => {
  it('reads the name from the nearest package.json', () => {
    const viteRoot = dir('packages', 'apps', 'web')
    manifest(viteRoot, JSON.stringify({ name: '@acme/web' }))

    expect(findAppName(viteRoot, gitRoot)).toBe('@acme/web')
  })

  it('walks up to find one, when the Vite root has none of its own', () => {
    const pkg = dir('packages', 'admin')
    manifest(pkg, JSON.stringify({ name: '@acme/admin' }))
    const viteRoot = dir('packages', 'admin', 'src', 'client')

    expect(findAppName(viteRoot, gitRoot)).toBe('@acme/admin')
  })

  it('prefers the nearest over the one at the git root — the monorepo case', () => {
    manifest(gitRoot, JSON.stringify({ name: 'the-monorepo' }))
    const viteRoot = dir('packages', 'apps', 'web')
    manifest(viteRoot, JSON.stringify({ name: '@acme/web' }))

    expect(findAppName(viteRoot, gitRoot)).toBe('@acme/web')
  })

  it('resolves the git root’s own package when the two coincide', () => {
    // A single-package repo. There is nothing to disambiguate, but the field is stamped
    // anyway so that D1's `app` filter always has something to filter on.
    manifest(gitRoot, JSON.stringify({ name: 'my-app' }))

    expect(findAppName(gitRoot, gitRoot)).toBe('my-app')
  })

  it('stops at the git root rather than reading a parent repo’s package', () => {
    // `gitRoot` is itself inside the OS temp directory; the walk must not climb out of the
    // repository looking for a name it has no business reporting.
    const outer = mkdtempSync(join(tmpdir(), 'dogear-outer-'))
    try {
      const inner = join(outer, 'nested-repo')
      const viteRoot = join(inner, 'app')
      mkdirSync(viteRoot, { recursive: true })
      manifest(outer, JSON.stringify({ name: 'the-outer-repo' }))

      expect(findAppName(viteRoot, inner)).toBeUndefined()
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })

  it.each([
    { why: 'it declares no name', contents: JSON.stringify({ version: '1.0.0' }) },
    { why: 'the name is empty', contents: JSON.stringify({ name: '' }) },
    { why: 'the name is whitespace', contents: JSON.stringify({ name: '   ' }) },
    { why: 'the name is not a string', contents: JSON.stringify({ name: 42 }) },
    { why: 'the JSON is truncated', contents: '{"name": "@acme/web"' },
    { why: 'it is not an object', contents: '"just a string"' },
    { why: 'it is empty', contents: '' },
  ])('returns undefined when $why, and does not throw', ({ contents }) => {
    const viteRoot = dir('packages', 'apps', 'web')
    manifest(viteRoot, contents)

    expect(findAppName(viteRoot, gitRoot)).toBeUndefined()
  })

  it('does not fall back to a parent when the nearest package.json has no name', () => {
    // The nearest one IS the package the Vite root belongs to. Climbing past it would report
    // a different package's name, which is worse than reporting nothing in a field whose
    // only job is to tell two packages apart.
    manifest(gitRoot, JSON.stringify({ name: 'the-monorepo' }))
    const viteRoot = dir('packages', 'apps', 'web')
    manifest(viteRoot, JSON.stringify({ private: true }))

    expect(findAppName(viteRoot, gitRoot)).toBeUndefined()
  })

  it('returns undefined when there is no package.json anywhere in the repo', () => {
    expect(findAppName(dir('packages', 'apps', 'web'), gitRoot)).toBeUndefined()
  })

  it('trims a padded name', () => {
    const viteRoot = dir('web')
    manifest(viteRoot, JSON.stringify({ name: '  @acme/web  ' }))

    expect(findAppName(viteRoot, gitRoot)).toBe('@acme/web')
  })

  it('terminates when the start directory is not below the git root at all', () => {
    // A misconfiguration rather than a supported shape, but it must return rather than spin:
    // `current === stopAt` can never fire here, leaving only the filesystem-root guard to
    // end the walk.
    //
    // The *result* is deliberately not asserted. This walk climbs past the temp directory
    // towards the filesystem root, and whether it meets a real package.json on the way is a
    // property of the machine running the test, not of this function. Completing at all is
    // the whole claim — a regression hangs here and the suite times out.
    const elsewhere = mkdtempSync(join(tmpdir(), 'dogear-elsewhere-'))
    try {
      const result = findAppName(elsewhere, gitRoot)
      expect(result === undefined || typeof result === 'string').toBe(true)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})
