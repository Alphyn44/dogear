import { describe, expect, it } from 'vitest'

import type { InitOptions } from './options.js'
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODIFIER,
  MODIFIERS,
  resolveOptions,
} from './options.js'

/**
 * `resolveOptions` had no test file before B5 (#12), which was defensible while it resolved
 * one field with one rule. It resolves two now, both of which arrive off a **query string** —
 * so the compiler's word that a value is a `Modifier` or a `string` is worth nothing, and the
 * fallbacks are the only thing standing between a typo in a Vite config and a dev tool
 * throwing during page load.
 */

describe('resolveOptions', () => {
  it('supplies every default for no options at all', () => {
    expect(resolveOptions(undefined)).toEqual({
      modifier: DEFAULT_MODIFIER,
      endpoint: DEFAULT_ENDPOINT,
    })
  })

  it('supplies every default for an empty object', () => {
    expect(resolveOptions({})).toEqual({
      modifier: DEFAULT_MODIFIER,
      endpoint: DEFAULT_ENDPOINT,
    })
  })

  it.each(MODIFIERS)('passes %s through', (modifier) => {
    expect(resolveOptions({ modifier }).modifier).toBe(modifier)
  })

  it.each([
    { why: 'a modifier that is not one', value: 'ctr1' },
    { why: 'an empty string', value: '' },
    { why: 'a number that survived JSON', value: 3 },
    { why: 'null', value: null },
  ])('falls back rather than throwing on $why', ({ value }) => {
    // Falls back, deliberately, where the *plugin* throws on the same value. Two audiences:
    // the plugin's is a developer reading a terminal, core's is a page load in a browser
    // where a throw has broken the app dogear exists to help inspect.
    const options = { modifier: value } as unknown as InitOptions

    expect(resolveOptions(options).modifier).toBe(DEFAULT_MODIFIER)
  })

  it('passes a configured endpoint through unchanged', () => {
    // Unchanged, not re-normalised: the plugin ran `normaliseEndpoint` before serialising it,
    // and a second implementation of that rule in core is one that can disagree.
    expect(resolveOptions({ endpoint: '/deep/nested' }).endpoint).toBe('/deep/nested')
  })

  it.each([
    { why: 'an empty string', value: '' },
    { why: 'a number', value: 5 },
    { why: 'null', value: null },
    { why: 'an object', value: {} },
  ])('falls back to the default endpoint on $why', ({ value }) => {
    // Without this, the failure is a POST to `/undefined/annotations` — answered 200 with
    // index.html by Vite's SPA fallback, which is the one failure shape that does not look
    // like one.
    const options = { endpoint: value } as unknown as InitOptions

    expect(resolveOptions(options).endpoint).toBe(DEFAULT_ENDPOINT)
  })

  it('resolves the two fields independently', () => {
    expect(resolveOptions({ modifier: 'meta', endpoint: '/x' })).toEqual({
      modifier: 'meta',
      endpoint: '/x',
    })
  })
})
