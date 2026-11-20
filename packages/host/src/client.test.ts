import { describe, expect, it } from 'vitest'

import type { InitOptions } from '../../core/src/options.js'
import {
  DEFAULT_ENDPOINT as CORE_DEFAULT_ENDPOINT,
  DEFAULT_MODIFIER as CORE_DEFAULT_MODIFIER,
  MODIFIERS as CORE_MODIFIERS,
} from '../../core/src/options.js'
// ./client-config.js, NOT ./client.js — the latter self-starts on import and would try to
// mount an overlay in a Node test.
import {
  CONFIG_PARAM as CORE_CONFIG_PARAM,
  readConfig,
} from '../../core/src/client-config.js'
import {
  buildClientConfig,
  clientScriptSrc,
  CONFIG_PARAM,
  DEFAULT_MODIFIER,
  MODIFIERS,
  resolveCoreDist,
} from './client.js'
import { DEFAULT_ENDPOINT } from './endpoint.js'

/**
 * The guard on the plugin↔core contract.
 *
 * `packages/vite/src/client.ts` hand-writes copies of core's `Modifier` and `MODIFIERS` for
 * the reason the brief already settled for SENTINEL: importing `dogear-core` by name
 * resolves through the exports map to `dist/`, so `npm run typecheck` — which runs on every
 * turn that touches a `.ts` file — would need a prior `npm run build`; and a relative import
 * of core's source is refused by `tsconfig.build.json`'s `rootDir: "src"`.
 *
 * This file may do what the source may not. Test files sit outside the build tsconfig and
 * outside the tsup entry, so the rootDir rule does not reach them and nothing here ships.
 * Exactly the licence ./sentinel.test.ts already uses.
 */

describe('the modifier contract with dogear-core', () => {
  it('has not drifted', () => {
    expect([...MODIFIERS].sort()).toEqual([...CORE_MODIFIERS].sort())
  })

  it('agrees on the default', () => {
    expect(DEFAULT_MODIFIER).toBe(CORE_DEFAULT_MODIFIER)
  })

  it('serialises an object core would accept', () => {
    // The assertion is the *annotation*, not the expect. This is a compile-time proof that
    // runs as a runtime test: if core adds a required field to InitOptions or narrows
    // `modifier`, this line stops compiling and `npm run typecheck` fails — while costing
    // nothing at build time, because the import is confined to a file neither tsup nor
    // tsconfig.build.json can see.
    const config: InitOptions = buildClientConfig({
      modifier: 'ctrl',
      endpoint: '/__dogear',
    })

    expect(config.modifier).toBe('ctrl')
  })

  it('defaults the modifier when none is given', () => {
    expect(buildClientConfig({ endpoint: '/__dogear' }).modifier).toBe('alt')
  })
})

/**
 * B5's (#12) half of the same contract. Core POSTs to `<endpoint>/annotations`, so the two
 * copies of the base path have to agree or a submit 404s against the app's SPA fallback —
 * which answers 200 with `index.html`, so it would not even look like a failure.
 */
describe('the endpoint contract with dogear-core', () => {
  it('agrees on the default', () => {
    expect(DEFAULT_ENDPOINT).toBe(CORE_DEFAULT_ENDPOINT)
  })

  it('passes the endpoint through rather than defaulting it', () => {
    // Required, not optional: `configureServer` has already normalised it, and defaulting
    // here could hand core a path the middleware is not mounted at.
    expect(buildClientConfig({ endpoint: '/custom' }).endpoint).toBe('/custom')
  })
})

/**
 * E7's (#40) half of the contract — `hosts` from `.dogear/config.json` to F3's guard.
 *
 * The `InitOptions` annotation below is the real assertion, as it is for `modifier`: if the
 * two hand-written copies of the type ever disagree about `hosts`, this file stops compiling
 * and `npm run typecheck` fails.
 */
describe('the hosts contract with dogear-core', () => {
  it('serialises a list core would accept', () => {
    const config: InitOptions = buildClientConfig({
      endpoint: '/__dogear',
      hosts: ['localhost', '*.test'],
    })

    expect(config.hosts).toEqual(['localhost', '*.test'])
  })

  it('leaves the key off entirely when no list was configured', () => {
    // **Absent, not equal to the defaults.** Sending dogear-vite's copy of DEFAULT_HOSTS
    // would pin it: a plugin one version behind dogear-core would keep overriding core's
    // list with a stale one it never chose — the same failure the brief's E4 entry rejects
    // for writing defaults into the config file. Omitted means "core decides".
    expect(buildClientConfig({ endpoint: '/__dogear' })).not.toHaveProperty('hosts')
  })

  it('round-trips a list through the URL into core', () => {
    const src = clientScriptSrc('/__dogear', {
      modifier: 'alt',
      endpoint: '/__dogear',
      hosts: ['localhost', '10.0.0.0/8'],
    })

    expect(readConfig(`http://localhost:5173${src}`).hosts).toEqual([
      'localhost',
      '10.0.0.0/8',
    ])
  })

  it('round-trips an empty list, which is a thing a config may say', () => {
    // `[]` has to survive the wire distinguishably from absence, or "dogear runs nowhere"
    // would silently become "dogear runs on the defaults".
    const src = clientScriptSrc('/__dogear', {
      modifier: 'alt',
      endpoint: '/__dogear',
      hosts: [],
    })

    expect(readConfig(`http://localhost:5173${src}`).hosts).toEqual([])
  })
})

describe('clientScriptSrc', () => {
  it('points at the served bundle under the configured endpoint', () => {
    expect(
      clientScriptSrc('/__dogear', { modifier: 'alt', endpoint: '/__dogear' }),
    ).toContain('/__dogear/client.js?')
  })

  it('agrees with core on the parameter name', () => {
    // The two halves cannot import each other at build time (rootDir, exports map), so this
    // is the only thing keeping the query key in step.
    expect(CONFIG_PARAM).toBe(CORE_CONFIG_PARAM)
  })

  it('round-trips the config through the URL into core', () => {
    // The whole contract in one assertion: what the plugin encodes is what core decodes,
    // driven through core's real `readConfig` rather than a reimplementation of it.
    const src = clientScriptSrc('/__dogear', { modifier: 'ctrl', endpoint: '/__dogear' })

    expect(readConfig(`http://localhost:5173${src}`)).toEqual({
      modifier: 'ctrl',
      endpoint: '/__dogear',
    })
  })

  it('round-trips a non-default endpoint, which is the whole of B5 reaching core', () => {
    const src = clientScriptSrc('/deep/nested', {
      modifier: 'alt',
      endpoint: '/deep/nested',
    })

    expect(readConfig(`http://localhost:5173${src}`).endpoint).toBe('/deep/nested')
  })

  it.each([
    { endpoint: '/__dogear', why: 'the ordinary case' },
    {
      endpoint: '/x"></script><script>alert(1)</script',
      why: 'an endpoint that used to be able to terminate the inline script',
    },
    { endpoint: '/<!--', why: 'an HTML comment opener' },
  ])('survives $why with the config intact', ({ endpoint }) => {
    // `endpoint` is user-supplied and lands in an HTML attribute. There is no inline body to
    // terminate any more, but the config still has to survive it, and `&`/`=`/`#` in a value
    // must not split the parameter — which is what encoding the whole JSON blob buys.
    const src = clientScriptSrc(endpoint, { modifier: 'meta', endpoint })
    const query = src.slice(src.indexOf('?'))

    expect(readConfig(`http://localhost:5173/x${query}`)).toEqual({
      modifier: 'meta',
      endpoint,
    })
  })
})

describe('readConfig', () => {
  it.each([
    { url: 'http://x/client.js', why: 'no query at all' },
    { url: 'http://x/client.js?config=', why: 'an empty value' },
    { url: 'http://x/client.js?config=%7Bnope', why: 'malformed JSON' },
    {
      url: 'http://x/client.js?config=%5B1%2C2%5D',
      why: 'valid JSON that is not an object',
    },
    {
      url: 'http://x/client.js?config=null',
      why: 'JSON null, which typeof calls an object',
    },
    { url: 'not a url at all', why: 'an unparseable module URL' },
  ])('falls back to defaults for $why', ({ url }) => {
    // Falls back rather than throwing, for the same reason `resolveOptions` does: a malformed
    // URL is a bug in the plugin, and a dev tool throwing during page load has broken the app
    // it exists to help you inspect.
    expect(readConfig(url)).toEqual({})
  })
})

describe('resolveCoreDist', () => {
  it('finds the live bundle, not the noop', () => {
    // The whole reason this goes via `dogear-core/package.json`: resolving the package NAME
    // from Node names no `development` condition, so it falls through the exports map to
    // dist/noop.js — the inert build. Serving that would leave the overlay silently doing
    // nothing, with no error anywhere to explain it.
    //
    // Skipped rather than failed when core has not been built: `npm test` is deliberately
    // build-independent, and `npm run verify` runs `build` before the suites that need it.
    const dist = resolveCoreDist()
    if (dist === undefined) return

    expect(dist.bundle.replaceAll('\\', '/')).toMatch(/packages\/core\/dist\/client\.js$/)
    expect(dist.bundle).not.toContain('noop')
  })
})
