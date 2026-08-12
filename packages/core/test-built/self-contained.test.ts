import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The served bundle must not import anything.
 *
 * This exists because of a defect that shipped past a fully green `npm run verify`. F4 (#34)
 * added a third tsup entry, at which point tsup's default code splitting hoisted the shared
 * overlay into a `chunk-XXXX.js` and rewrote `dist/client.js` to open with
 * `import { init } from "./chunk-XXXX.js"`.
 *
 * @dogear/vite serves that file as a **single response** at `<endpoint>/client.js`. A sibling
 * import sends the browser to `<endpoint>/chunk-XXXX.js`, which the endpoint answers with its
 * 404 — so the overlay silently never loads. Every existing suite passed: the endpoint tests
 * serve a synthetic two-line bundle, and the injection tests only inspect HTML. Nothing but a
 * real browser, or this, would have caught it.
 *
 * Lives in test-built/ because it reads real build output — `npm run test:built`, after a
 * build. `npm test` stays build-independent.
 */

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

/** Static `import`/`export … from` specifiers, which are what a browser would go and fetch. */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g

describe('dist/client.js — the file @dogear/vite serves', () => {
  const source = readFileSync(join(dist, 'client.js'), 'utf8')

  it('has been built', () => {
    expect(source.length).toBeGreaterThan(0)
  })

  it('imports nothing at all', () => {
    // Bare specifiers would be equally fatal — the dev server serves one file, not a module
    // graph — so this asserts on every specifier rather than only relative ones.
    const specifiers = [...source.matchAll(SPECIFIER)].map((match) => match[1])

    expect(
      specifiers,
      'the served bundle must be self-contained. Check `splitting: false` in ' +
        "packages/core/tsup.config.ts — a sibling chunk import 404s against dogear's " +
        'endpoint and the overlay never loads.',
    ).toEqual([])
  })

  it('carries the sentinel, restoring the second carrier the inline script used to be', () => {
    expect(source).toContain('__DOGEAR_DEV_ONLY__')
  })

  it('self-starts, because nothing calls init() any more', () => {
    expect(source).toContain('__dogear')
  })
})

describe('the rest of dist', () => {
  it('emits no shared chunks', () => {
    // The direct form of the same rule, and the one that fails loudly if a fourth entry is
    // added later and the splitting default quietly comes back.
    const chunks = readdirSync(dist).filter((name) => name.startsWith('chunk-'))

    expect(chunks).toEqual([])
  })

  it('keeps the sentinel out of the noop, which is what production resolves to', () => {
    // check:leak asserts this too. Repeated here because this file is where someone will be
    // looking after changing the entry list, and the two entries are easy to confuse.
    expect(readFileSync(join(dist, 'noop.js'), 'utf8')).not.toContain(
      '__DOGEAR_DEV_ONLY__',
    )
  })
})
