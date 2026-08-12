// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createController } from './controller.js'
import { HOST_TAG } from './overlay.js'
import { isEnabled, PREFERENCE_KEY, resetPreferenceCache } from './preference.js'

/**
 * B6 (#13) — the start/stop cycle, and the file where the ticket's headline claim is
 * actually asserted.
 *
 * "When disabled, listeners are **detached, not ignored**" is a structural statement, so it
 * gets a structural test: count what is attached to `window` before and after. Counting
 * rather than probing behaviour is deliberate — a behavioural test ("does an alt-click still
 * capture?") passes just as happily against a handler that ran and decided to do nothing,
 * which is the exact failure mode the rule exists to forbid.
 */

/**
 * Every object dogear attaches to, spied individually.
 *
 * `EventTarget.prototype` alone is not enough and fails *silently* in the worst way: happy-dom's
 * `Window` and `Document` define their own `addEventListener` as own-properties rather than
 * inheriting, so a prototype spy sees none of the window-level listeners — which is nearly all
 * of them. The count then reads zero both while running and after teardown, and every
 * "listeners are gone" assertion passes without testing anything. Caught here only because the
 * paired `> baseline` assertions failed.
 *
 * Own-property spies shadow the prototype, so nothing is double-counted: window calls hit the
 * window spy, and the badge and panel inside the shadow root hit the prototype one.
 */
const SPIED = [globalThis.window, globalThis.document, EventTarget.prototype] as const

/**
 * How many listeners are attached and not yet removed.
 *
 * The subtraction is the whole point. `removeEventListener` fails **silently** when the
 * capture flag does not match the one used to add — so a listener can look removed and still
 * fire. Matching pairs is the closest a test gets to the real question without a browser.
 */
function liveListeners(): number {
  return SPIED.reduce((total, target) => {
    const added = vi.mocked(target.addEventListener).mock.calls.length
    const removed = vi.mocked(target.removeEventListener).mock.calls.length
    return total + added - removed
  }, 0)
}

function hostCount(): number {
  return document.querySelectorAll(HOST_TAG).length
}

/** Attached before dogear existed, so an unrelated listener cannot make an assertion lie. */
let baseline: number

/**
 * Clear anything a previous test left mounted.
 *
 * `document.body.innerHTML = ''` is not enough and the reason is B7 (#14) itself: the host is
 * appended to `document.documentElement`, so it is a sibling of `<body>` and emptying the body
 * leaves it exactly where it was. Tests here that end with a running controller over a
 * non-empty queue mount one deliberately — the badge has a count to show — so this has real
 * work to do.
 */
function removeStrayHosts(): void {
  for (const host of document.querySelectorAll(HOST_TAG)) host.remove()
}

beforeEach(() => {
  globalThis.localStorage.clear()
  resetPreferenceCache()
  document.body.innerHTML = ''
  removeStrayHosts()

  // Spies that call through — the listeners really are attached, they are just counted on
  // the way past.
  for (const target of SPIED) {
    vi.spyOn(target, 'addEventListener')
    vi.spyOn(target, 'removeEventListener')
  }
  baseline = liveListeners()
})

afterEach(() => {
  globalThis.localStorage.clear()
  resetPreferenceCache()
  removeStrayHosts()
  vi.restoreAllMocks()
})

describe('the disabled state', () => {
  it('detaches every listener it attached — not ignores them', () => {
    // THE test for this ticket.
    const controller = createController()
    controller.start()
    expect(liveListeners()).toBeGreaterThan(baseline)

    controller.disable()

    expect(liveListeners()).toBe(baseline)
  })

  it('leaves no nodes behind', () => {
    const controller = createController()
    controller.start()
    controller.disable()

    expect(hostCount()).toBe(0)
    expect(document.querySelector(HOST_TAG)).toBeNull()
  })

  it('leaves the document byte-identical to one dogear never loaded into', () => {
    const before = document.documentElement.outerHTML
    const controller = createController()
    controller.start()

    controller.disable()

    expect(document.documentElement.outerHTML).toBe(before)
  })

  it('attaches nothing at all when booting into a stored disable', () => {
    // The reload case, and the one the shortcut alone cannot prove.
    globalThis.localStorage.setItem(PREFERENCE_KEY, 'false')
    const controller = createController()

    const started = controller.boot()

    expect(started).toBe(false)
    expect(controller.running).toBe(false)
    expect(liveListeners()).toBe(baseline)
    expect(hostCount()).toBe(0)
  })
})

describe('boot', () => {
  it('starts when nothing has been stored', () => {
    const controller = createController()

    expect(controller.boot()).toBe(true)
    expect(controller.running).toBe(true)

    controller.stop()
  })

  it('reports whether it started, so the caller can say so without re-reading the pref', () => {
    globalThis.localStorage.setItem(PREFERENCE_KEY, 'false')

    expect(createController().boot()).toBe(false)
  })
})

describe('persistence', () => {
  it('disable() persists', () => {
    const controller = createController()
    controller.start()

    controller.disable()

    expect(isEnabled()).toBe(false)
    // And a fresh controller — a reload — honours it.
    expect(createController().boot()).toBe(false)
  })

  it('stop() does NOT persist — it is B1’s teardown and nothing more', () => {
    // Merging the two was considered and rejected: a console `stop()` during debugging would
    // otherwise follow the developer across every future page load in that browser, with the
    // cause several reloads behind them.
    const controller = createController()
    controller.start()

    controller.stop()

    expect(isEnabled()).toBe(true)
    expect(createController().boot()).toBe(true)
  })

  it('start() clears a stored disable, since asking now outranks asking last time', () => {
    globalThis.localStorage.setItem(PREFERENCE_KEY, 'false')
    const controller = createController()
    controller.boot()

    controller.start()

    expect(controller.running).toBe(true)
    expect(isEnabled()).toBe(true)
  })
})

describe('the cycle', () => {
  it('comes back after a disable, with listeners reattached', () => {
    const controller = createController()
    controller.start()
    controller.disable()

    controller.start()

    expect(controller.running).toBe(true)
    expect(liveListeners()).toBeGreaterThan(baseline)
  })

  it('survives repeated cycles without leaking listeners', () => {
    // The leak this catches is real: `removeEventListener` fails *silently* when the capture
    // flag does not match, so a registry bug would show up here as a count that grows.
    const controller = createController()

    for (let round = 0; round < 3; round += 1) {
      controller.start()
      controller.disable()
    }

    expect(liveListeners()).toBe(baseline)
    expect(hostCount()).toBe(0)
  })

  it.each([
    {
      why: 'start twice',
      run: (c: ReturnType<typeof createController>) => {
        c.start()
        c.start()
      },
    },
    {
      why: 'boot then start',
      run: (c: ReturnType<typeof createController>) => {
        c.boot()
        c.start()
      },
    },
  ])('does not build twice on $why', ({ run }) => {
    const controller = createController()
    run(controller)
    const attached = liveListeners()

    // One teardown has to be enough. If `start` had built twice, the second set would survive.
    controller.disable()

    expect(attached).toBeGreaterThan(baseline)
    expect(liveListeners()).toBe(baseline)
  })

  it.each([
    {
      why: 'stop twice',
      run: (c: ReturnType<typeof createController>) => {
        c.stop()
        c.stop()
      },
    },
    {
      why: 'disable twice',
      run: (c: ReturnType<typeof createController>) => {
        c.disable()
        c.disable()
      },
    },
    {
      why: 'stop before it ever started',
      run: (c: ReturnType<typeof createController>) => {
        c.stop()
      },
    },
  ])('is a no-op on $why', ({ run }) => {
    const controller = createController()

    expect(() => {
      run(controller)
    }).not.toThrow()
    expect(controller.running).toBe(false)
  })

  it('tracks running across every verb', () => {
    const controller = createController()
    expect(controller.running).toBe(false)

    controller.start()
    expect(controller.running).toBe(true)

    controller.stop()
    expect(controller.running).toBe(false)

    controller.start()
    controller.disable()
    expect(controller.running).toBe(false)
  })
})

/**
 * The batch survives the cycle, which is what makes the kill switch unconditional.
 *
 * Before this, the queue lived in the session closure and a teardown destroyed it — so
 * disabling had to refuse whenever anything was pending, and the panel's Disable button was
 * therefore unreachable in every state where it would have worked. Owning the queue here
 * removed the refusal, the dead end, and the silent loss in `stop()` together.
 */
describe('the batch across a disable', () => {
  const draft = {
    comment: 'shade this darker',
    element: { tag: 'button', id: null, classes: ['tab'], text: 'Settings' },
    url: 'http://localhost:5173/settings',
    viewport: { w: 1512, h: 945, dpr: 2 },
    authoredAt: '2026-08-12T10:00:00.000Z',
  }

  it('survives disable and re-enable', () => {
    const controller = createController()
    controller.start()
    controller.queue.add(draft)

    controller.disable()
    controller.start()

    expect(controller.queue.count).toBe(1)
    expect(controller.queue.items[0]?.comment).toBe('shade this darker')
  })

  it('survives stop() and start() — the console path used to eat it', () => {
    const controller = createController()
    controller.start()
    controller.queue.add(draft)

    controller.stop()
    controller.start()

    expect(controller.queue.count).toBe(1)
  })

  it('is still there while disabled, with nothing rendered for it', () => {
    // The distinction the whole design rests on: the queue is data, not a listener and not a
    // node. Keeping it alive costs neither guarantee.
    const controller = createController()
    controller.start()
    controller.queue.add(draft)

    controller.disable()

    expect(controller.queue.count).toBe(1)
    expect(liveListeners()).toBe(baseline)
    expect(hostCount()).toBe(0)
  })

  it('keeps its keys, so nothing re-points after a rebuild', () => {
    const controller = createController()
    controller.start()
    const first = controller.queue.add(draft)
    const second = controller.queue.add({ ...draft, comment: 'and this' })

    controller.disable()
    controller.start()

    expect(controller.queue.items.map((item) => item.key)).toEqual([
      first.key,
      second.key,
    ])
  })

  it('starts empty on a fresh controller — a reload really does clear it', () => {
    const controller = createController()
    controller.start()
    controller.queue.add(draft)
    controller.disable()

    // A new controller is what a page load builds.
    expect(createController().queue.count).toBe(0)
  })
})

describe('the options flag', () => {
  it('builds nothing when the host passed enabled: false', () => {
    // A separate axis from the stored preference: this is the project's choice, and it wins.
    // @dogear/vite never gets here — a disabled plugin injects no script — so this is the
    // library entry's path.
    const controller = createController({ enabled: false })

    expect(controller.boot()).toBe(true)
    expect(liveListeners()).toBe(baseline)
    expect(hostCount()).toBe(0)
  })
})
