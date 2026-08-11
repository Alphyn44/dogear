import { describe, expect, it } from 'vitest'

import type { InitOptions } from '../../core/src/options.js'
import {
  DEFAULT_MODIFIER as CORE_DEFAULT_MODIFIER,
  MODIFIERS as CORE_MODIFIERS,
} from '../../core/src/options.js'
import {
  buildClientConfig,
  clientTagSource,
  DEFAULT_MODIFIER,
  MODIFIERS,
  resolveCoreDist,
} from './client.js'
import { SENTINEL } from './sentinel.js'

/**
 * The guard on the plugin↔core contract.
 *
 * `packages/vite/src/client.ts` hand-writes copies of core's `Modifier` and `MODIFIERS` for
 * the reason the brief already settled for SENTINEL: importing `@dogear/core` by name
 * resolves through the exports map to `dist/`, so `npm run typecheck` — which runs on every
 * turn that touches a `.ts` file — would need a prior `npm run build`; and a relative import
 * of core's source is refused by `tsconfig.build.json`'s `rootDir: "src"`.
 *
 * This file may do what the source may not. Test files sit outside the build tsconfig and
 * outside the tsup entry, so the rootDir rule does not reach them and nothing here ships.
 * Exactly the licence ./sentinel.test.ts already uses.
 */

describe('the modifier contract with @dogear/core', () => {
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
    const config: InitOptions = buildClientConfig({ modifier: 'ctrl' })

    expect(config.modifier).toBe('ctrl')
  })

  it('defaults the modifier when none is given', () => {
    expect(buildClientConfig({}).modifier).toBe('alt')
  })
})

describe('clientTagSource', () => {
  const source = clientTagSource('/__dogear', { modifier: 'alt' })

  it('imports init from the endpoint that serves it', () => {
    expect(source).toContain('import { init } from "/__dogear/client.js"')
  })

  it('carries the sentinel in the body as well as on the tag attribute', () => {
    expect(source).toContain(SENTINEL)
  })

  it('exposes the teardown, so B6 is provable by hand from a console', () => {
    expect(source).toContain('stop: init(')
  })

  it.each([
    { endpoint: '/__dogear', why: 'the ordinary case' },
    {
      endpoint: '/x"></script><script>alert(1)</script',
      why: 'a hostile endpoint option',
    },
    { endpoint: '/<!--', why: 'an HTML comment opener, which also confuses the parser' },
    { endpoint: '/<script', why: 'a nested opening tag' },
  ])('cannot be escaped out of by $why', ({ endpoint }) => {
    // `endpoint` is user-supplied and reaches the import specifier of an INLINE script, so
    // this is the one place a plugin option can rewrite the page. Escaping every `<` rather
    // than matching on `</script` covers all three parser hazards at once, and stays valid
    // JavaScript because `<` in a string literal is simply `<`.
    const hostile = clientTagSource(endpoint, { modifier: 'alt' })

    expect(hostile).not.toContain('</script')
    expect(hostile).not.toContain('<!--')
    expect(hostile).not.toContain('<script')
  })

  it('emits valid JavaScript for a hostile endpoint rather than mangling it', () => {
    // Escaping that produced a syntax error would be a different bug with the same test
    // passing. `new Function` parses without executing.
    const hostile = clientTagSource('/x"></script>', { modifier: 'alt' })

    expect(
      () => new Function(`return () => { ${hostile.replace(/^import .*$/m, '')} }`),
    ).not.toThrow()
  })
})

describe('resolveCoreDist', () => {
  it('finds the live bundle, not the noop', () => {
    // The whole reason this goes via `@dogear/core/package.json`: resolving the package NAME
    // from Node names no `development` condition, so it falls through the exports map to
    // dist/noop.js — the inert build. Serving that would leave the overlay silently doing
    // nothing, with no error anywhere to explain it.
    //
    // Skipped rather than failed when core has not been built: `npm test` is deliberately
    // build-independent, and `npm run verify` runs `build` before the suites that need it.
    const dist = resolveCoreDist()
    if (dist === undefined) return

    expect(dist.bundle.replaceAll('\\', '/')).toMatch(/packages\/core\/dist\/index\.js$/)
    expect(dist.bundle).not.toContain('noop')
  })
})
