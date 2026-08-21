import { describe, expect, it } from 'vitest'

import { DEFAULT_HOSTS } from './host.js'
import type { InitOptions } from './options.js'
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODIFIER,
  MODIFIERS,
  resolveHosts,
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
      enabled: true,
    })
  })

  it('supplies every default for an empty object', () => {
    expect(resolveOptions({})).toEqual({
      modifier: DEFAULT_MODIFIER,
      endpoint: DEFAULT_ENDPOINT,
      enabled: true,
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

  it('resolves the fields independently', () => {
    expect(resolveOptions({ modifier: 'meta', endpoint: '/x', enabled: false })).toEqual({
      modifier: 'meta',
      endpoint: '/x',
      enabled: false,
    })
  })

  // B6 (#13) — the hard off.
  it('defaults to enabled', () => {
    expect(resolveOptions({}).enabled).toBe(true)
  })

  it('turns off for a literal false', () => {
    expect(resolveOptions({ enabled: false }).enabled).toBe(false)
  })

  it.each([
    { why: 'the string false, which is truthy', value: 'false' },
    { why: 'zero', value: 0 },
    { why: 'null', value: null },
    { why: 'an empty string', value: '' },
  ])('stays enabled for $why — only a real false counts', ({ value }) => {
    // Same safe direction as ./preference.ts: a dev tool that is unexpectedly on can be
    // switched off, while one that is unexpectedly absent reads as broken. `enabled: 0` from
    // a hand-edited config should not silently uninstall dogear.
    const options = { enabled: value } as unknown as InitOptions

    expect(resolveOptions(options).enabled).toBe(true)
  })

  it('does not carry hosts, which belongs to the guard rather than the session', () => {
    // `ResolvedOptions` is what `createSession` receives and every field on it is one the
    // session reads. F3's list is consumed once, before a session exists — see `resolveHosts`.
    expect(resolveOptions({ hosts: ['localhost'] })).not.toHaveProperty('hosts')
  })
})

/**
 * E7 (#40). Separate from `resolveOptions` because it is consumed at a different moment by a
 * different caller: `init()` hands it to the host guard and never refers to it again.
 *
 * Its rule is also different, and deliberately so — every fallback above is per-field, while
 * this one is all-or-nothing. Half of a safety list is not a safety list.
 */
describe('resolveHosts', () => {
  it('defaults to DEFAULT_HOSTS', () => {
    expect(resolveHosts(undefined)).toBe(DEFAULT_HOSTS)
    expect(resolveHosts({})).toBe(DEFAULT_HOSTS)
  })

  it('passes a well-formed list through unchanged', () => {
    expect(resolveHosts({ hosts: ['localhost', '*.test'] })).toEqual([
      'localhost',
      '*.test',
    ])
  })

  it('honours an empty list as "nowhere"', () => {
    // Not read as absence. `.dogear/config.json` is allowed to say that dogear runs nowhere,
    // and reading `[]` as "unset" would silently override whoever meant it.
    expect(resolveHosts({ hosts: [] })).toEqual([])
  })

  it.each([
    { why: 'a string', value: 'localhost' },
    { why: 'null', value: null },
    { why: 'an object', value: { 0: 'localhost' } },
    { why: 'a list with a number in it', value: ['localhost', 7] },
    { why: 'a list of nulls', value: [null] },
  ])('falls back to the defaults for $why', ({ value }) => {
    // Wholesale, not per-entry: dropping the bad entries would silently *widen* a list its
    // author was narrowing. dogear-vite does the per-entry dropping, in a terminal where it
    // can name what it dropped — so anything malformed by the time it reaches here was
    // hand-written onto the query parameter.
    const options = { hosts: value } as unknown as InitOptions

    expect(resolveHosts(options)).toBe(DEFAULT_HOSTS)
  })
})
