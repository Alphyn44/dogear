import { readFileSync } from 'node:fs'

import { DEFAULT_ENDPOINT, RECOGNISED_KEYS } from 'dogear-host'
import { describe, expect, it } from 'vitest'

/**
 * J7 (#83): dogear-next's package page, held to the code the way G6 (#51) holds dogear-vite's.
 *
 * npm renders this README and nothing else, so it is the only place a Next user can learn that
 * `.dogear/config.json` exists, what `hosts` does, or that the package is a runtime dependency.
 * The same rules as ../../vite/src/docs.test.ts, asserted again rather than shared because each
 * page has to stand alone: a key documented on the Vite page is still undocumented for someone
 * who only ever reads this one.
 *
 * Keys rather than prose, as there: each assertion is that a name is *present*, because the
 * failure this is built for is a key added to {@link RECOGNISED_KEYS} and not to the table.
 *
 * Paths are relative to the repository root, which is where vitest runs from.
 */

const README = 'packages/next/README.md'
const ROOT_README = 'README.md'

const read = (path: string): string => readFileSync(path, 'utf8')
const readme = read(README)

describe('the dogear-next README on .dogear/config.json', () => {
  it.each(RECOGNISED_KEYS)('documents the `%s` key', (key) => {
    expect(readme).toContain(`\`${key}\``)
  })

  it('names the file at the git root, which is not the app directory', () => {
    expect(readme).toContain('.dogear/config.json')
    expect(readme).toContain('git root')
  })

  it('says a bad value is dropped rather than thrown on', () => {
    expect(readme).toMatch(/warn|warning/i)
  })

  it('says the file is read once, so an edit needs a restart', () => {
    expect(readme).toContain('restart')
  })
})

describe('the dogear-next README on hosts', () => {
  it('says the list replaces the defaults rather than extending them', () => {
    expect(readme).toContain('replaces')
  })

  it('names every default host', () => {
    // Read out of core's source as text, for the reason ../../vite/src/docs.test.ts gives:
    // importing `dogear-core` would resolve to `dist/` and put a build on `npm test`.
    const host = read('packages/core/src/host.ts')
    const start = host.indexOf('DEFAULT_HOSTS')
    const defaults = host
      .slice(start, host.indexOf('])', start))
      .match(/'([^']+)'/g)
      ?.map((quoted) => quoted.slice(1, -1))

    expect(
      defaults,
      'could not read DEFAULT_HOSTS out of core. Has it moved?',
    ).toHaveLength(8)

    for (const entry of defaults ?? []) expect(readme).toContain(entry)
  })
})

describe('the dogear-next README on the endpoint', () => {
  it('names the default', () => {
    expect(readme).toContain(DEFAULT_ENDPOINT)
  })

  it('lists all four things an endpoint may not be', () => {
    expect(readme).toContain('not `/`')
    expect(readme).toContain('//host')
    expect(readme).toContain('query')
    expect(readme).toContain('fragment')
  })
})

/**
 * The wiring both pages show is the wiring `dogear init` prints (G6's rule: the READMEs agree
 * with the code on what init writes and prints).
 *
 * Each line is checked in ../../cli/src/guidance.ts as text too, so a change to the snippet
 * init prints fails here until both pages follow, rather than leaving them showing the old one.
 */
const SNIPPET = [
  "import { withDogear } from 'dogear-next'",
  'export default withDogear(nextConfig)',
]

describe('the wiring the READMEs show', () => {
  it('is the snippet dogear init prints', () => {
    const guidance = read('packages/cli/src/guidance.ts')

    for (const line of SNIPPET) expect(guidance).toContain(line)
  })

  it.each([README, ROOT_README])('appears in %s', (path) => {
    for (const line of SNIPPET) expect(read(path)).toContain(line)
  })

  it.each([README, ROOT_README])(
    'installs dogear-next as a runtime dependency in %s, as init says to',
    (path) => {
      // `next start` loads next.config in production, so `-D` would break a deploy that
      // prunes devDependencies. guidance.ts gives dogear-next the `runtime` field for this.
      expect(read(path)).toMatch(/npm i dogear-next\b/)
      expect(read(path)).not.toMatch(/npm i -D [^\n]*dogear-next/)
    },
  )
})
