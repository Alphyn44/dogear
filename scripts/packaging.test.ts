import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * G1 (#42): what has to be inside a published tarball, pinned before G2 (#43) makes one.
 *
 * Two rules, and neither is obvious from reading a manifest:
 *
 * **npm takes the licence file from the package directory, not the repository root.** A
 * monorepo with one root LICENSE publishes three tarballs that declare `"license": "MIT"`
 * and contain no licence text at all — the field says one thing and the contents say
 * nothing. So each publishable package carries its own copy, and copies drift, which is
 * what the byte-identity assertion is for.
 *
 * **`files` does not govern the README.** npm always includes `README.md`, `LICENSE`,
 * `package.json` and `CHANGELOG` whatever `files` says, so listing `README.md` there is
 * documentation rather than mechanism. It is asserted anyway because the entry is easy to
 * drop by someone who knows the rule and reasonable to keep by someone who does not — and
 * a manifest that lists it is a manifest whose author considered the question.
 *
 * This suite reads real repository files but needs no build, so it belongs in the fast
 * `npm test` run alongside scripts/check-leak.test.ts rather than in the build-dependent
 * gate under scripts/gate/. Paths are relative to the repository root, which is where
 * vitest runs from.
 */

/** The three that publish. See below for why @dogear/queue is not among them. */
const PUBLISHED = ['core', 'vite', 'cli'] as const

const read = (path: string): string => readFileSync(path, 'utf8')

interface Manifest {
  readonly name?: string
  readonly private?: boolean
  readonly files?: readonly string[]
}

const manifest = (dir: string): Manifest =>
  JSON.parse(read(`packages/${dir}/package.json`)) as Manifest

describe.each(PUBLISHED)('@dogear/%s', (dir) => {
  it('has a README of its own', () => {
    // npm renders the package's own README on the package page and nothing else. A scoped
    // package without one gets a blank page, which for @dogear/vite is the page `dogear
    // init` sends a new user to.
    expect(
      existsSync(`packages/${dir}/README.md`),
      `packages/${dir}/README.md is missing — npm does not walk up to the root README.`,
    ).toBe(true)
  })

  it('lists README.md in files', () => {
    expect(manifest(dir).files).toContain('README.md')
  })

  it('carries the root LICENSE verbatim', () => {
    const local = `packages/${dir}/LICENSE`

    expect(existsSync(local), `${local} is missing — the tarball would ship none.`).toBe(
      true,
    )
    expect(read(local), `${local} has drifted from the root LICENSE.`).toBe(
      read('LICENSE'),
    )
  })
})

describe('@dogear/queue', () => {
  /**
   * The exclusion is deliberate and worth a failing test if it stops being true.
   *
   * The package has no build — its `exports` points straight at `src/index.ts` — and the
   * other three inline it via `noExternal`. Publishing it would add a runtime dependency
   * to an install story that has none, and would put `dist/*.d.ts` on the critical path
   * for `npm run typecheck`, which CI runs *before* it builds. See CLAUDE.md.
   */
  it('stays private', () => {
    expect(manifest('queue').private).toBe(true)
  })

  it('ships no package page or licence copy', () => {
    expect(existsSync('packages/queue/README.md')).toBe(false)
    expect(existsSync('packages/queue/LICENSE')).toBe(false)
  })
})
