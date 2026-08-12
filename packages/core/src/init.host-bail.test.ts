// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://shop.example.com/checkout" }

import { afterEach, describe, expect, it, vi } from 'vitest'

import { init } from './init.js'

/**
 * F3 (#7), layer 5 — finally with a caller.
 *
 * Its own file, because the whole point is a non-local hostname and the environment URL is
 * per-file. `https://shop.example.com` is the scenario the layer exists for and nothing
 * else: every structural defence above it has failed, and core is live in a real user's
 * browser on a deployed site.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe('init on a host that is not local', () => {
  it('is running on the hostname this file exists to test', () => {
    // Guards the docblock above. If the environment option is ever dropped or renamed, every
    // assertion below would pass on localhost while testing the opposite scenario.
    expect(location.hostname).toBe('shop.example.com')
  })

  it('returns a callable teardown rather than undefined', () => {
    // Same contract as the live path, so a caller doing `const stop = init(); stop()` does
    // not crash on the one page where a dogear-shaped error is least explicable.
    const stop = init()

    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })

  it('attaches nothing and renders nothing', () => {
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener')
    const before = document.documentElement.outerHTML

    init()

    expect(add).not.toHaveBeenCalled()
    expect(document.documentElement.outerHTML).toBe(before)
  })

  it.each(['log', 'info', 'warn', 'error', 'debug'] as const)(
    'says nothing on console.%s — the bail is silent by decision',
    (method) => {
      // Not an oversight and not a missing diagnostic. This code path runs on a deployed
      // page in front of real users; a `[dogear] refusing to initialize` line would announce
      // a dev tool on the one page it must be invisible on. Diagnostics belong on the
      // dev-side path. See the brief's Decisions log.
      const spy = vi.spyOn(console, method).mockImplementation(() => {})

      init()

      expect(spy).not.toHaveBeenCalled()
    },
  )
})
