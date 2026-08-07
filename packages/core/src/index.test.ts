import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { IS_NOOP } from './index.js'
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
