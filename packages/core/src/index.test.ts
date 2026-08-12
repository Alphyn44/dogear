import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import * as index from './index.js'
import { IS_NOOP } from './index.js'
import * as noop from './noop.js'
import { IS_NOOP as IS_NOOP_IN_NOOP_BUILD } from './noop.js'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  // `./package.json` maps to a bare string rather than a conditions object, so the value
  // type is a union rather than the nested record the '.' entry alone would suggest.
) as { exports?: Record<string, Record<string, string> | string> }

const entry = manifest.exports?.['.']
if (entry === undefined || typeof entry === 'string') {
  throw new Error('packages/core/package.json is missing its "." export')
}

describe('module surface', () => {
  it('the real module reports itself as live', () => {
    expect(IS_NOOP).toBe(false)
  })

  it('the noop build reports itself as inert', () => {
    expect(IS_NOOP_IN_NOOP_BUILD).toBe(true)
  })

  it('the noop exports everything the real module does', () => {
    // ./noop.ts states this rule; until now nothing enforced it. A missing counterpart is
    // not a build-time type error — it is an undefined import that surfaces only in a
    // production bundle, because the noop is what a production resolver actually gets.
    //
    // B1 (#8) is the first ticket to grow this surface, which is what the guard was put in
    // place for. `sentinel.ts` needs no exception here: it is deliberately not re-exported
    // from ./index.ts, so it is not part of the surface being compared. Type-only exports
    // are erased and never reach Object.keys. See the brief's Decisions log.
    expect(Object.keys(noop).sort()).toEqual(Object.keys(index).sort())
  })

  it.each([
    { module: 'index', init: index.init },
    { module: 'noop', init: noop.init },
  ])('$module exports an init that returns a callable teardown', ({ init }) => {
    // The specific shape, not just presence. `init()` is documented as
    // `const stop = init(); …; stop()`, and F1's layer 2 fixture uses
    // `import('@dogear/core').then((m) => m.init())` — a noop returning undefined turns
    // either into "stop is not a function", in a production bundle, from the module whose
    // whole job is to make production inert.
    expect(typeof init).toBe('function')
    expect(typeof init()).toBe('function')
    expect(() => init()()).not.toThrow()
  })

  it('the noop imports nothing but types', () => {
    // The leak gate cannot see this one. `scripts/gate/no-leaks.test.ts` scans
    // dist/noop.js for the sentinel, and a bundled overlay carries no sentinel — so a
    // value import here would ship the whole of B1's DOM code into every production build
    // and pass every content scan on the way. `verbatimModuleSyntax` erases `import type`
    // completely; a plain `import` is what breaks it.
    const source = readFileSync(new URL('./noop.ts', import.meta.url), 'utf8')
    const imports = source.match(/^import .*$/gm) ?? []

    expect(imports.length).toBeGreaterThan(0)
    for (const statement of imports) {
      expect(
        statement,
        'noop.ts may only use `import type`. A value import bundles the overlay into ' +
          'the file production resolves to, which layer 3 exists to prevent.',
      ).toMatch(/^import type /)
    }
  })
})

describe('exports map (F1, layer 3)', () => {
  // A shape assertion, deliberately: it reads package.json rather than resolving
  // through dist/, so `npm test` stays independent of `npm run build`. F1 (#5) adds
  // the resolution test that actually loads the built files under each condition.
  it.each([
    {
      condition: 'development',
      target: './dist/index.js',
      why: 'Vite sets this during serve',
    },
    {
      condition: 'production',
      target: './dist/noop.js',
      why: 'Vite sets this during build',
    },
    {
      condition: 'default',
      target: './dist/noop.js',
      why: 'an unrecognised condition must fail safe, not fall through to the overlay',
    },
  ])('routes $condition to $target — $why', ({ condition, target }) => {
    expect(entry[condition]).toBe(target)
  })

  it('lists types first, because the first matching condition wins', () => {
    expect(Object.keys(entry)[0]).toBe('types')
  })

  it('exposes ./package.json, which is how @dogear/vite finds the dev bundle', () => {
    // The plugin serves core's built bundle at <endpoint>/client.js and needs an absolute
    // path to it. Resolving the package NAME from Node names no `development` condition, so
    // it lands on dist/noop.js — the inert build. Resolving the manifest and joining
    // `dist/index.js` gets the live one, deliberately, and only inside a dev server.
    //
    // A dedicated `./dev` subpath was rejected: it would be a second live entry point any
    // bundler could follow, which is the hole layer 3 exists to close. This entry exposes a
    // manifest, not code, so `@dogear/core` still resolves to the noop for every consumer.
    expect(manifest.exports?.['./package.json']).toBe('./package.json')
  })
})
