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

/**
 * E7 (#40) — `hosts` reaching this guard from `.dogear/config.json`.
 *
 * This file's hostname is what makes it the right place: `shop.example.com` is denied by
 * `DEFAULT_HOSTS`, so a list that *allows* it proves the supplied array replaced the defaults
 * rather than being intersected with them. The narrowing direction is covered in
 * ./host.test.ts, which can stub any hostname it likes.
 */
describe('init with a configured host list', () => {
  /**
   * How many listeners `init` attached — the observable difference between running and
   * bailing, since the overlay mounts its host lazily and `outerHTML` is unchanged either way.
   *
   * Spied **per target**, never on `EventTarget.prototype`: happy-dom defines
   * `addEventListener` as an own property on both `window` and `document`, and vitest installs
   * its own `window.addEventListener` wrapper besides, so a prototype spy records none of the
   * window-level listeners — which is nearly all of them. It fails in the worst way, reading
   * zero whether dogear ran or not, so every bail assertion would pass vacuously. Same reason
   * ./teardown.test.ts and ./controller.test.ts spy this way.
   */
  function listenersAttachedBy(start: () => () => void): number {
    const onWindow = vi.spyOn(window, 'addEventListener')
    const onDocument = vi.spyOn(document, 'addEventListener')

    const stop = start()
    const count = onWindow.mock.calls.length + onDocument.mock.calls.length
    stop()

    return count
  }

  it('starts on a host the defaults deny, when the list allows it', () => {
    // `shop.example.com` is denied by DEFAULT_HOSTS, so this passing proves the supplied list
    // *replaced* the defaults rather than being intersected with them.
    expect(
      listenersAttachedBy(() => init({ hosts: ['shop.example.com'] })),
    ).toBeGreaterThan(0)
  })

  it('still bails when the list does not name this host', () => {
    // Paired with the assertion above so a vacuous zero cannot hide: the same measurement
    // returns a positive number one test earlier.
    expect(listenersAttachedBy(() => init({ hosts: ['localhost'] }))).toBe(0)
  })

  it('bails on a malformed list rather than trusting half of it', () => {
    // `resolveHosts` rejects wholesale and falls back to DEFAULT_HOSTS, which deny this page.
    // A per-entry filter would have kept 'shop.example.com' and started dogear on a deployed
    // site — the failure direction that actually matters for a safety layer.
    const hosts = ['shop.example.com', 7] as unknown as readonly string[]

    expect(listenersAttachedBy(() => init({ hosts }))).toBe(0)
  })
})
