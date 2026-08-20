import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * What has to be true of a package before it publishes — G1 (#42) for the tarball's
 * contents, G2 (#43) for the flags that let it leave the machine at all.
 *
 * Four rules, and none of them is obvious from reading a manifest:
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
 * **`private: true` is one edit away from being restored by accident, and there is no
 * other signal.** A package that regains it does not fail to build, typecheck or test —
 * it fails at `npm publish`, in CI, on a tag, which is the worst place to find out. The
 * version assertion is the same shape: `0.0.0` is npm's default for a package nobody has
 * released, so a new package that lands here unversioned is caught rather than published.
 *
 * **A workspace wildcard publishes verbatim.** `"@dogear/core": "*"` resolves to the
 * local copy while developing and to *anything on the registry* once installed, so a
 * future breaking core would satisfy the plugin's dependency. G2 replaced it with a real
 * range; this pins that, because `*` is precisely what `npm install -w` writes back if
 * anyone re-adds the dependency, and the regression would be silent.
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
  readonly version?: string
  readonly private?: boolean
  readonly files?: readonly string[]
  readonly dependencies?: Readonly<Record<string, string>>
}

const manifest = (dir: string): Manifest =>
  JSON.parse(read(`packages/${dir}/package.json`)) as Manifest

/**
 * Semver's own shape, loosely — three dot-separated numbers and an optional tail.
 *
 * Deliberately not a full semver parser. The failure this guards against is a package
 * arriving with no version, `latest`, or a range where a version belongs, and any of
 * those is caught here without vendoring a spec's worth of grammar.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/

describe.each(PUBLISHED)('@dogear/%s', (dir) => {
  it('is publishable', () => {
    // `private: true` refuses `npm publish` outright. Absent is the only correct value
    // here — `private: false` would work and would read as though someone had weighed it
    // per package, which is the opposite of what the flag means now.
    expect(
      manifest(dir).private,
      `packages/${dir} is private — npm publish would refuse it.`,
    ).toBeUndefined()
  })

  it('carries a real version', () => {
    const { version } = manifest(dir)

    expect(version).toMatch(SEMVER)
    // npm's default for a package nobody has released. Shipping it would burn the version
    // every later release has to climb past.
    expect(version, `packages/${dir} still carries npm's placeholder version.`).not.toBe(
      '0.0.0',
    )
  })

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

describe('@dogear/vite', () => {
  /**
   * The plugin's one published runtime dependency, and the only cross-package range that
   * reaches a consumer's `node_modules`.
   *
   * It is a real dependency rather than a bundled one: the plugin resolves
   * `@dogear/core/package.json` to locate the bundle it serves at `<endpoint>/client.js`.
   * So the range is load-bearing in a way the `@dogear/queue` devDependencies below are
   * not — those are inlined at build time and never installed by anyone downstream.
   */
  it('names a concrete range for @dogear/core', () => {
    const range = manifest('vite').dependencies?.['@dogear/core']

    expect(range).toBeDefined()
    // Each of these resolves to the workspace copy while developing and to something
    // unbounded once published. `workspace:*` is npm 9+ syntax that also survives the
    // round trip and would name a protocol no registry consumer can resolve at all.
    expect(
      ['*', 'latest', 'workspace:*', 'workspace:^'],
      'a wildcard here publishes verbatim — any future @dogear/core would satisfy it.',
    ).not.toContain(range)
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
