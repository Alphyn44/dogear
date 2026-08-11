import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import * as index from './index.js'
import { IS_NOOP } from './index.js'
import * as noop from './noop.js'
import { IS_NOOP as IS_NOOP_IN_NOOP_BUILD } from './noop.js'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports?: Record<string, Record<string, string>> }

const entry = manifest.exports?.['.']
if (entry === undefined) {
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
    // Trivially true while both modules export only IS_NOOP, which is exactly why it is
    // worth having before B1 and C1 grow this surface. `sentinel.ts` needs no exception
    // here: it is deliberately not re-exported from ./index.ts, so it is not part of the
    // surface being compared. See the brief's Decisions log.
    expect(Object.keys(noop).sort()).toEqual(Object.keys(index).sort())
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
})
