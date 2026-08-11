// @vitest-environment happy-dom

import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createListenerRegistry, type ListenerRegistry } from './listeners.js'
import type { Modifier } from './options.js'
import { createOverlay, type Overlay } from './overlay.js'
import { createSession, isHeld, type Session } from './session.js'

/**
 * B2 (#9) and B1 (#8)'s behaviour, minus everything that needs a layout engine.
 *
 * happy-dom returns a zero rect from `getBoundingClientRect` and has no hit testing, so both
 * are supplied: targets get a stubbed rect, and `document.elementFromPoint` is replaced with
 * one that returns whatever the test points it at. That leaves this file asserting the state
 * machine and the suppression — the parts that are genuinely logic — and leaves "does the
 * frame land on the element" to the manual pass, which is the only thing that could settle
 * it anyway.
 */

const RECT = { x: 10, y: 20, width: 100, height: 40 }

let registry: ListenerRegistry
let overlay: Overlay
let session: Session
let target: HTMLElement
let appHandler: Mock<(event: Event) => void>

/** Give an element a real rect, since happy-dom has no layout. */
function withRect(element: HTMLElement, rect = RECT): HTMLElement {
  element.getBoundingClientRect = () =>
    ({
      ...rect,
      top: rect.y,
      left: rect.x,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => rect,
    }) as DOMRect
  return element
}

/** Point hit testing at `element` — or at nothing. */
function pointAt(element: Element | null): void {
  document.elementFromPoint = () => element
}

function start(modifier: Modifier = 'alt'): void {
  registry = createListenerRegistry()
  overlay = createOverlay()
  session = createSession({ registry, overlay, options: { modifier } })
}

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }))
}

/** Dispatch from the target, so it travels the real capture path down from window. */
function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 50,
    clientY: 40,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  target = withRect(document.createElement('button'))
  target.className = 'tab'
  target.textContent = 'Settings'
  document.body.append(target)

  appHandler = vi.fn<(event: Event) => void>()
  target.addEventListener('click', appHandler)

  pointAt(target)
  start()
})

afterEach(() => {
  registry.detachAll()
  overlay.destroy()
  target.remove()
  vi.restoreAllMocks()
})

describe('isHeld', () => {
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

  it.each([
    { modifier: 'alt', event: { ...none, altKey: true }, expected: true },
    { modifier: 'ctrl', event: { ...none, ctrlKey: true }, expected: true },
    { modifier: 'meta', event: { ...none, metaKey: true }, expected: true },
    { modifier: 'shift', event: { ...none, shiftKey: true }, expected: true },
    { modifier: 'alt', event: { ...none, ctrlKey: true }, expected: false },
    { modifier: 'alt', event: none, expected: false },
  ] as const)('$modifier held=$expected for $event', ({ modifier, event, expected }) => {
    expect(isHeld(event, modifier)).toBe(expected)
  })
})

describe('B2 — the hover outline', () => {
  it('outlines on keydown with no pointer motion at all', () => {
    // The reason there is an always-on pointermove listener. Without the last known
    // position, "hold Alt and the thing under the cursor outlines" would require a jiggle.
    key('keydown', { key: 'Alt', altKey: true })

    expect(overlay.mounted).toBe(true)
  })

  it('follows the pointer from one element to the next while armed', () => {
    // The outline has to track the cursor, not just appear once. Refreshing only when the
    // armed *state* changes would leave it stuck on whatever was under the cursor when the
    // key went down — which is B2 not working at all, while every other test here passes.
    key('keydown', { key: 'Alt', altKey: true })

    const second = withRect(document.createElement('p'), {
      x: 300,
      y: 400,
      width: 80,
      height: 20,
    })
    document.body.append(second)
    pointAt(second)
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 320, clientY: 410, altKey: true }),
    )

    const outline = overlay.root.querySelector('.outline:not(.outline--captured)')
    expect((outline as HTMLElement).style.transform).toBe('translate3d(300px, 400px, 0)')

    second.remove()
  })

  it('clears and unmounts on keyup', () => {
    key('keydown', { key: 'Alt', altKey: true })
    key('keyup', { key: 'Alt', altKey: false })

    expect(overlay.mounted).toBe(false)
  })

  it.each([
    {
      disarm: () => {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        document.dispatchEvent(new Event('visibilitychange'))
      },
      why: 'tab switch, which does not blur the window on every platform',
    },
    {
      disarm: () =>
        window.dispatchEvent(
          new PointerEvent('pointermove', { clientX: 50, clientY: 40 }),
        ),
      why: 'a pointer event arriving with the flag clear — released outside the window',
    },
    {
      disarm: () => key('keyup', { key: 'Alt', altKey: true }),
      why: 'a keyup naming the modifier key even though the flag still reads true',
    },
  ])('a stuck modifier is cleared by $why', ({ disarm }) => {
    key('keydown', { key: 'Alt', altKey: true })
    expect(overlay.mounted).toBe(true)

    disarm()

    expect(overlay.mounted).toBe(false)
  })

  it.each([
    {
      blur: () => window.dispatchEvent(new Event('blur')),
      why: 'a window blur — pressing Alt on Windows focuses the browser menu, which blurs the page, so disarming here would tear the outline down on the very key that raised it',
    },
    {
      blur: () => target.dispatchEvent(new FocusEvent('blur', { bubbles: false })),
      why: 'an element blur — tabbing between two inputs is not a reason to stop pointing',
    },
  ])('survives $why', ({ blur }) => {
    key('keydown', { key: 'Alt', altKey: true })

    blur()

    expect(overlay.mounted).toBe(true)
  })

  it('still suppresses correctly after a blur, because suppression never reads `armed`', () => {
    // The safety argument for dropping the blur disarm. A stuck `armed` must not be able to
    // eat a plain click, and it cannot: every suppression handler reads the modifier flag
    // off its own event.
    key('keydown', { key: 'Alt', altKey: true })
    window.dispatchEvent(new Event('blur'))

    const plain = mouse('click')

    expect(appHandler).toHaveBeenCalledTimes(1)
    expect(plain.defaultPrevented).toBe(false)
  })

  it.each([
    {
      type: 'keydown' as const,
      why: "Firefox reveals its menu bar on the modifier's keydown",
    },
    {
      type: 'keyup' as const,
      why: 'Chrome and Edge activate theirs on the keyup instead',
    },
  ])("cancels the modifier's $type while outlining — $why", ({ type }) => {
    key('keydown', { key: 'Alt', altKey: true })

    const event = new KeyboardEvent(type, {
      key: 'Alt',
      altKey: type === 'keydown',
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it("leaves the browser's own menu key alone when dogear is idle", () => {
    // The other half of the trade. Suppressing unconditionally would take Alt away from the
    // user for as long as the page had focus, which is not dogear's to take.
    pointAt(null)

    const event = new KeyboardEvent('keyup', {
      key: 'Alt',
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  it('mounts nothing when the target has no boxes', () => {
    // display:none and empty inlines both measure zero. Outlining one draws a 2px dot in
    // the corner of the viewport, which reads as a bug.
    pointAt(withRect(document.createElement('span'), { x: 0, y: 0, width: 0, height: 0 }))

    key('keydown', { key: 'Alt', altKey: true })

    expect(overlay.mounted).toBe(false)
  })

  it('ignores the overlay itself as a hover target', () => {
    // The shadow retarget guard. The comment box turns pointer-events back on, and a hit
    // inside a closed shadow root retargets to the host — without this, hovering the box
    // would outline the overlay.
    key('keydown', { key: 'Alt', altKey: true })
    pointAt(overlay.host)

    session.refresh()

    expect(overlay.mounted).toBe(false)
  })
})

describe("B1 — the app's own handler does not fire", () => {
  it.each(['click', 'pointerdown', 'mousedown', 'dblclick'] as const)(
    'suppresses %s while the modifier is held',
    (type) => {
      const spy = vi.fn()
      target.addEventListener(type, spy)

      const event = mouse(type, { altKey: true })

      expect(spy).not.toHaveBeenCalled()
      // preventDefault is separate from stopping propagation: it is the only thing that
      // cancels the browser's own alt-click (Firefox "save link", Chrome "download link").
      expect(event.defaultPrevented).toBe(true)
    },
  )

  it('leaves a plain click completely alone', () => {
    const event = mouse('click')

    expect(appHandler).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
    expect(overlay.mounted).toBe(false)
  })

  it('does not suppress events from inside its own comment box', () => {
    // Without the host check, modifier-clicking into the textarea would cancel its own
    // focus and selection.
    mouse('click', { altKey: true })
    const inBox = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      altKey: true,
    })

    overlay.host.dispatchEvent(inBox)

    expect(inBox.defaultPrevented).toBe(false)
  })
})

describe('B1 — capture', () => {
  it('outlines the element and opens a focused comment box', () => {
    mouse('click', { altKey: true })

    const box = overlay.root.querySelector('.box')
    expect(overlay.mounted).toBe(true)
    expect(box).not.toBeNull()
    expect((box as HTMLElement).hidden).toBe(false)
    expect(overlay.root.querySelector('.label')?.textContent).toBe(
      'button.tab — "Settings"',
    )
    expect(overlay.root.activeElement).toBe(overlay.root.querySelector('.input'))
  })

  it('survives disarming — the box outlives the keypress', () => {
    mouse('click', { altKey: true })

    key('keyup', { key: 'Alt', altKey: false })

    expect(overlay.mounted).toBe(true)
  })

  it('closes on Escape, which is B3 pulled forward so the box is dismissable', () => {
    mouse('click', { altKey: true })

    key('keydown', { key: 'Escape' })

    expect(overlay.mounted).toBe(false)
  })

  it('releases when HMR removes the captured element from the document', () => {
    mouse('click', { altKey: true })

    target.remove()
    pointAt(null)
    session.refresh()

    expect(overlay.mounted).toBe(false)
  })
})

describe('a configured modifier', () => {
  beforeEach(() => {
    registry.detachAll()
    overlay.destroy()
    start('ctrl')
  })

  it('captures on ctrl-click', () => {
    mouse('click', { ctrlKey: true })

    expect(overlay.mounted).toBe(true)
  })

  it('treats alt-click as an ordinary click', () => {
    const event = mouse('click', { altKey: true })

    expect(appHandler).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
  })

  it('cancels contextmenu, because Ctrl+click IS the context menu on macOS', () => {
    const event = mouse('contextmenu', { ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
  })
})
