import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { RECOGNISED_KEYS } from './config-file.js'
import { DEFAULT_ENDPOINT } from './endpoint.js'

/**
 * G6 (#51): the package page has to describe the config file, and cannot go stale silently.
 *
 * A source rule in the shape ../../cli/src/docs.test.ts established for the command list, and
 * it exists for a sharper reason than that one did. `.dogear/config.json`'s keys were
 * documented only in `dogear-brief.md`, and `files` is `["dist", "README.md"]` — so the brief
 * is not in the tarball, npm renders this README and nothing else, and a reader who installed
 * the plugin had no reachable way to learn that `hosts` exists. `hosts` is also the one key
 * that is a safety decision rather than a preference, which makes it the worst one to hide.
 *
 * Keys rather than prose: this asserts each name is *present*, not how it is described. The
 * failure it is built for is a key added to {@link RECOGNISED_KEYS} and not to the table —
 * which is silent in every other way, since an undocumented key still works.
 *
 * Paths are relative to the repository root, which is where vitest runs from.
 */

const README = 'packages/vite/README.md'

const readme = readFileSync(README, 'utf8')

describe('the dogear-vite README on .dogear/config.json', () => {
  // Backticked, so the match is the key as code rather than the English word — `include`,
  // `transform` and `enabled` all appear in ordinary sentences on this page.
  it.each(RECOGNISED_KEYS)('documents the `%s` key', (key) => {
    expect(readme).toContain(`\`${key}\``)
  })

  it('names the file at the git root, which is not the Vite root', () => {
    // The commonest wrong guess in a monorepo, and the one that produces a config that is
    // never read rather than an error.
    expect(readme).toContain('.dogear/config.json')
    expect(readme).toContain('git root')
  })

  it('says a bad value is dropped rather than thrown on', () => {
    // The asymmetry with a plugin option is the whole reason this file has a validator, and a
    // reader who assumes it throws will not go looking in the terminal for the warning.
    expect(readme).toMatch(/warn|warning/i)
  })

  it('says the file is read once, so an edit needs a restart', () => {
    expect(readme).toContain('restart')
  })
})

describe('the dogear-vite README on hosts', () => {
  it('says the list replaces the defaults rather than extending them', () => {
    // The difference between "add my tunnel domain" and "turn dogear off on my LAN
    // address", and nothing in the code can warn about getting it wrong.
    expect(readme).toContain('replaces')
  })

  it('names every default host', () => {
    // Read out of core's source rather than restated here, and rather than imported: the
    // plugin deliberately keeps no copy of DEFAULT_HOSTS — serialising one would pin it, and
    // a plugin a release behind core would override the list on behalf of a project that
    // never chose one, which is why `hosts` is omitted from the wire when unset. Importing
    // `dogear-core` would resolve through its exports map to `dist/`, which would put a build
    // on `npm test`'s critical path. A source rule costs neither.
    const host = readFileSync('packages/core/src/host.ts', 'utf8')
    const start = host.indexOf('DEFAULT_HOSTS')
    const defaults = host
      .slice(start, host.indexOf('])', start))
      .match(/'([^']+)'/g)
      ?.map((quoted) => quoted.slice(1, -1))

    expect(
      defaults,
      'could not read DEFAULT_HOSTS out of core — has it moved?',
    ).toHaveLength(8)

    for (const entry of defaults ?? []) expect(readme).toContain(entry)
  })
})

describe('the dogear-vite README on the endpoint', () => {
  it('names the default', () => {
    expect(readme).toContain(DEFAULT_ENDPOINT)
  })

  it('lists all four things an endpoint may not be', () => {
    // normaliseEndpoint has four rules and this page listed three until G6. The missing one
    // was the site root, which is the only one a reader might plausibly try.
    expect(readme).toContain('not `/`')
    expect(readme).toContain('//host')
    expect(readme).toContain('query')
    expect(readme).toContain('fragment')
  })
})
