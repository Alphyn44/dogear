// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { init } from './init.js'

/**
 * B6's (#13) settled rule — "listeners are **detached, not ignored**" — proved one milestone
 * before B6 ships its UI, because it is an architectural property and retrofitting it later
 * would mean rewriting every handler.
 *
 * It takes two tests. Each alone is weak: the structural one cannot tell a live listener
 * from an early-returning one, and the behavioural one cannot prove there is nothing left
 * that simply happens not to matter yet. Together they are airtight.
 */

let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/**
 * `target:type:capture` for every call recorded on one spy.
 *
 * Capture belongs in the signature because it is part of a listener's identity —
 * `removeEventListener(type, handler)` does not remove one added with `{ capture: true }`,
 * and the mismatch fails silently rather than throwing.
 */
function signatures(label: string, calls: unknown[][]): string[] {
  return calls.map(([type, , options]) => {
    const capture =
      typeof options === 'boolean'
        ? options
        : ((options as AddEventListenerOptions)?.capture ?? false)
    return `${label}:${String(type)}:${capture ? 'capture' : 'bubble'}`
  })
}

describe('the teardown init() returns', () => {
  it('removes every listener it added', () => {
    // Spied on the two concrete targets rather than `EventTarget.prototype`, and that is not
    // a workaround — it is the more precise claim. init() attaches to `window` and
    // `document` and nothing else, so this asserts exactly that. The prototype spy also
    // records nothing here: vitest installs its own `window.addEventListener` wrapper as an
    // own property (to count user error listeners), so window calls never reach the
    // prototype at all.
    const targets = [
      { label: 'window', target: window as EventTarget },
      { label: 'document', target: document as EventTarget },
    ]
    const spies = targets.map(({ label, target }) => ({
      label,
      add: vi.spyOn(target, 'addEventListener'),
      remove: vi.spyOn(target, 'removeEventListener'),
    }))

    const teardown = init()
    const attached = spies
      .flatMap((spy) => signatures(spy.label, spy.add.mock.calls))
      .sort()
    teardown()
    const detached = spies
      .flatMap((spy) => signatures(spy.label, spy.remove.mock.calls))
      .sort()

    expect(attached.length).toBeGreaterThan(0)
    expect(detached).toEqual(attached)
  })

  it('stops suppressing clicks — the listener is gone, not early-returning', () => {
    // Behavioural, and the one a human recognises. The first assertion fails if dogear never
    // attached anything; the second fails if it attached and merely decided to do nothing.
    const target = document.createElement('button')
    const appHandler = vi.fn()
    target.addEventListener('click', appHandler)
    document.body.append(target)
    document.elementFromPoint = () => target

    stop = init()

    target.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    expect(appHandler).not.toHaveBeenCalled()

    stop()
    stop = undefined

    target.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    expect(appHandler).toHaveBeenCalledTimes(1)
  })

  it('leaves the document byte-identical to before init()', () => {
    const before = document.documentElement.outerHTML

    const teardown = init()
    teardown()

    expect(document.documentElement.outerHTML).toBe(before)
  })

  it('is idempotent', () => {
    const teardown = init()
    teardown()

    expect(() => teardown()).not.toThrow()
  })
})
