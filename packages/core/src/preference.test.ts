// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isEnabled,
  PREFERENCE_KEY,
  resetPreferenceCache,
  setEnabled,
} from './preference.js'

/**
 * B6's (#13) persisted flag.
 *
 * Half of this file is about storage that does not work, which is the reason the module
 * exists at all — `localStorage` throws in more situations than it is usually given credit
 * for, and every one of them is reachable from a dev server.
 */

beforeEach(() => {
  globalThis.localStorage.clear()
  resetPreferenceCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('reading', () => {
  it('is enabled when nothing has ever been written', () => {
    // The overwhelmingly common case, and the reason absence is the meaningful default.
    expect(isEnabled()).toBe(true)
  })

  it('is disabled when the key says so', () => {
    globalThis.localStorage.setItem(PREFERENCE_KEY, 'false')

    expect(isEnabled()).toBe(false)
  })

  it.each([
    { why: 'the string true', value: 'true' },
    { why: 'an empty string', value: '' },
    { why: 'something another tool wrote', value: '{"enabled":false}' },
    { why: 'a value from a version that does not exist yet', value: 'off' },
    { why: 'the wrong case', value: 'FALSE' },
  ])('reads as enabled for $why', ({ value }) => {
    // Compared to the exact string, and everything else means on. The safe direction: a dev
    // tool that is unexpectedly present can be switched off again, while one that is
    // unexpectedly absent looks broken.
    globalThis.localStorage.setItem(PREFERENCE_KEY, value)

    expect(isEnabled()).toBe(true)
  })
})

describe('writing', () => {
  it('records a disable', () => {
    setEnabled(false)

    expect(globalThis.localStorage.getItem(PREFERENCE_KEY)).toBe('false')
    expect(isEnabled()).toBe(false)
  })

  it('removes the key on re-enable rather than writing true', () => {
    // A developer who never touches the toggle should have nothing of dogear's in their
    // browser storage, and one who toggles twice should be back to that state.
    setEnabled(false)

    setEnabled(true)

    expect(globalThis.localStorage.getItem(PREFERENCE_KEY)).toBeNull()
    expect(Object.keys({ ...globalThis.localStorage })).not.toContain(PREFERENCE_KEY)
  })

  it('round-trips through several changes', () => {
    setEnabled(false)
    setEnabled(true)
    setEnabled(false)

    expect(isEnabled()).toBe(false)
  })

  it('is namespaced, since it shares an origin with the app under development', () => {
    expect(PREFERENCE_KEY).toBe('dogear:enabled')
  })
})

/**
 * The part that matters. Safari's private mode has thrown on `setItem` at quota, a sandboxed
 * iframe throws on *access* to the property, and Chrome throws on read with cookies blocked.
 * None is dogear's fault and none is worth an exception while an app is booting.
 */
describe('when storage does not work', () => {
  it('does not throw when setItem fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => {
      setEnabled(false)
    }).not.toThrow()
  })

  it('honours the preference for the rest of the page after a failed write', () => {
    // Degrading has to mean "stops persisting", not "stops working". Pressing the toggle and
    // watching nothing happen would be the worse failure.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    setEnabled(false)

    expect(isEnabled()).toBe(false)
  })

  it('does not throw when getItem fails, and reads as enabled', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied')
    })

    expect(isEnabled()).toBe(true)
  })

  it('survives localStorage being absent entirely', () => {
    // Not hypothetical: core is written to never assume a DOM global exists — the same reason
    // `isCurrentHostAllowed` reads `globalThis.location` rather than `window.location`.
    vi.stubGlobal('localStorage', undefined)

    expect(isEnabled()).toBe(true)
    expect(() => {
      setEnabled(false)
    }).not.toThrow()
  })

  it('keeps the in-memory preference when localStorage is absent', () => {
    vi.stubGlobal('localStorage', undefined)

    setEnabled(false)

    expect(isEnabled()).toBe(false)
  })

  it('lets a later real write take over from the fallback', () => {
    vi.stubGlobal('localStorage', undefined)
    setEnabled(false)
    vi.unstubAllGlobals()

    // Storage came back — the stored value is authoritative again, and there is none.
    expect(isEnabled()).toBe(true)
  })
})
