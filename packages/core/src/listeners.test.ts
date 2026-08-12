// @vitest-environment happy-dom

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { createListenerRegistry } from './listeners.js'

/**
 * happy-dom rather than node, because the thing under test is `addEventListener` /
 * `removeEventListener` semantics — and the semantics that matter (capture as part of
 * listener identity) cannot be exercised against a hand-rolled fake, which would agree with
 * whatever the implementation happened to do.
 *
 * The docblock above is how the environment is selected. vitest.config.ts pins
 * `environment: 'node'` for everything under packages/*\/src, and this overrides it for one
 * file — so the repo keeps three vitest configs selected by directory, with no exclude
 * rules and no fourth config, exactly as CLAUDE.md describes.
 */

describe('createListenerRegistry', () => {
  it('attaches on `on` and reports its size', () => {
    const registry = createListenerRegistry()
    const target = new EventTarget()
    const handler = vi.fn()

    registry.on(target, 'click', handler)
    target.dispatchEvent(new Event('click'))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(registry.size).toBe(1)
  })

  it('detachAll removes every listener and empties the registry', () => {
    const registry = createListenerRegistry()
    const target = new EventTarget()
    const first = vi.fn()
    const second = vi.fn()

    registry.on(target, 'click', first)
    registry.on(target, 'keydown', second)
    registry.detachAll()

    target.dispatchEvent(new Event('click'))
    target.dispatchEvent(new Event('keydown'))

    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(registry.size).toBe(0)
  })

  it.each([
    {
      options: { capture: true },
      why: 'capture listeners are the entire suppression set — B1 would survive teardown',
    },
    {
      options: { capture: true, passive: true },
      why: 'the pointermove tracker is both, and passive must not confuse the removal',
    },
    {
      options: { passive: true },
      why: 'passive without capture is still a bubble listener',
    },
    { options: undefined, why: 'the plain case, so the table has its own control' },
  ])('detachAll removes a listener added with $options — $why', ({ options }) => {
    // The bug this exists for: `removeEventListener(type, handler)` does NOT remove a
    // listener registered with `{ capture: true }` — capture is part of the listener's
    // identity — and the mismatch fails *silently* rather than throwing. Every window
    // listener the overlay attaches is a capture listener, so a registry that dropped the
    // options on removal would leave dogear eating clicks after teardown while reporting
    // size 0.
    const registry = createListenerRegistry()
    const target = new EventTarget()
    const handler = vi.fn()

    registry.on(target, 'click', handler, options)
    registry.detachAll()
    target.dispatchEvent(new Event('click'))

    expect(handler).not.toHaveBeenCalled()
  })

  it('is idempotent — a second detachAll does not throw', () => {
    const registry = createListenerRegistry()
    registry.on(new EventTarget(), 'click', vi.fn())

    registry.detachAll()

    expect(() => registry.detachAll()).not.toThrow()
    expect(registry.size).toBe(0)
  })

  it('tracks the same handler on two targets separately', () => {
    // One shared handler is the natural way to write the modifier machine (keydown and
    // keyup run the same function). If the registry keyed on the handler rather than the
    // whole registration, detaching one would report the other gone too.
    const registry = createListenerRegistry()
    const first = new EventTarget()
    const second = new EventTarget()
    const handler = vi.fn()

    registry.on(first, 'click', handler)
    registry.on(second, 'click', handler)
    expect(registry.size).toBe(2)

    registry.detachAll()
    first.dispatchEvent(new Event('click'))
    second.dispatchEvent(new Event('click'))

    expect(handler).not.toHaveBeenCalled()
  })
})

describe('the source rule', () => {
  // B6's "detach, don't ignore" is a claim about every listener in the package, so one
  // listener attached outside the registry falsifies it. A mechanical check is the only
  // kind that stays true — the alternative is remembering, during a review, a rule written
  // in a file nobody is looking at.
  // `fileURLToPath` on the string, rather than handing `node:fs` a `new URL(...)`. In a
  // happy-dom environment the global `URL` is happy-dom's, and Node's fs rejects it with
  // "The URL must be of scheme file" — a genuinely confusing error, since the URL looks
  // correct when printed.
  const directory = dirname(fileURLToPath(import.meta.url))
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => name !== 'listeners.ts')

  it('found sources to check', () => {
    // Without this, a rename of this directory turns the rule below into a loop over an
    // empty array — a test that passes by examining nothing.
    expect(sources.length).toBeGreaterThan(0)
  })

  it.each(sources)(
    '%s does not call addEventListener directly — every listener must be revocable',
    (name) => {
      const source = readFileSync(join(directory, name), 'utf8')

      expect(
        source,
        `${name} calls addEventListener outside listeners.ts. Route it through the ` +
          'registry init() owns, or B6 (#13) cannot guarantee a total detach.',
      ).not.toContain('addEventListener(')
    },
  )
})
