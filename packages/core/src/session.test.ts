// @vitest-environment happy-dom

import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HINT } from './box.js'
import { createListenerRegistry, type ListenerRegistry } from './listeners.js'
import type { Modifier } from './options.js'
import { createOverlay, type Overlay } from './overlay.js'
import type { QueueItem } from './queue.js'
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

function input(): HTMLTextAreaElement {
  return overlay.root.querySelector('.input') as HTMLTextAreaElement
}

/**
 * A keydown from inside the shadow root.
 *
 * Dispatched on the host rather than on the textarea because that is what the session
 * actually sees: an event crossing a closed shadow boundary retargets to the host, so by the
 * time it reaches the window-level handler `event.target` is the host either way.
 */
function keyInBox(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  overlay.host.dispatchEvent(event)
  return event
}

/** Capture the target and type a comment into the box, the way B3 assumes you got here. */
function captureAndType(text: string): void {
  mouse('click', { altKey: true })
  input().value = text
}

function badge(): HTMLButtonElement {
  return overlay.root.querySelector('.badge') as HTMLButtonElement
}

function panelRows(): HTMLLIElement[] {
  return [...overlay.root.querySelectorAll<HTMLLIElement>('.panel li.item')]
}

function panelOpen(): boolean {
  return (overlay.root.querySelector('.panel') as HTMLElement).hidden === false
}

function rowInput(index: number): HTMLTextAreaElement {
  const input = panelRows()[index]?.querySelector('.item-comment')
  if (!(input instanceof HTMLTextAreaElement)) throw new Error(`no row ${String(index)}`)
  return input
}

/** Capture the target, type, and queue — the state B4 assumes you arrive in. */
function queueComment(text: string): void {
  captureAndType(text)
  keyInBox({ key: 'Enter' })
}

/**
 * The first queued item.
 *
 * A function rather than `session.queue.items[0]` because `noUncheckedIndexedAccess` types
 * that as possibly undefined — and throwing here reads better in a failure than the
 * property access on undefined that an assertion operator would produce.
 */
function firstQueued(): QueueItem {
  const [item] = session.queue.items
  if (item === undefined) throw new Error('nothing was queued')
  return item
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

describe('B3 — comment and queue', () => {
  it('assembles the annotation Enter queues', () => {
    captureAndType('  shade this darker  ')

    keyInBox({ key: 'Enter' })

    expect(session.queue.items).toEqual([
      {
        key: expect.any(Number),
        // Trimmed, because @dogear/vite's validateBatch rejects the whole batch on a
        // comment that is not a non-empty trimmed string.
        comment: 'shade this darker',
        element: { tag: 'button', id: null, classes: ['tab'], text: 'Settings' },
        url: location.href,
        viewport: {
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio,
        },
        authoredAt: expect.any(String),
      },
    ])
    expect(Date.parse(firstQueued().authoredAt)).not.toBeNaN()
  })

  it('carries no id, status, createdAt or resolvedAt — the server owns all four', () => {
    // stampAnnotation spreads client fields through, so anything sent under one of these
    // names either gets discarded or, worse, lands in queue.json and breaks the
    // time-sortability UUIDv7 was chosen for.
    captureAndType('too dark')

    keyInBox({ key: 'Enter' })

    expect(Object.keys(firstQueued()).sort()).toEqual([
      'authoredAt',
      'comment',
      'element',
      'key',
      'url',
      'viewport',
    ])
  })

  it('records the element as it was when pointed at, not as it is at Enter', () => {
    // The text snippet is the agent's re-anchoring lifeline. Re-describing at Enter would
    // record whatever the app re-rendered into the element while the comment was typed.
    captureAndType('too dark')
    target.textContent = 'Something else entirely'

    keyInBox({ key: 'Enter' })

    expect(firstQueued().element.text).toBe('Settings')
  })

  it('releases on Enter, so the next thing you do is point somewhere else', () => {
    captureAndType('too dark')

    keyInBox({ key: 'Enter' })

    expect((overlay.root.querySelector('.box') as HTMLElement).hidden).toBe(true)
    expect((overlay.root.querySelector('.outline--captured') as HTMLElement).hidden).toBe(
      true,
    )
  })

  it('shows the pending count, and counts up', () => {
    const badge = () => overlay.root.querySelector('.badge') as HTMLElement

    expect(badge().hidden).toBe(true)

    captureAndType('first')
    keyInBox({ key: 'Enter' })
    expect(badge().hidden).toBe(false)
    expect(badge().textContent).toBe('1 pending')

    captureAndType('second')
    keyInBox({ key: 'Enter' })
    expect(badge().textContent).toBe('2 pending')
  })

  it('keeps the host mounted while the queue is non-empty — B7 (#14), narrowed', () => {
    // The decision B7 handed forward. A badge you can only see while holding the modifier
    // cannot tell you that you are carrying eight comments, which is most of what it is for.
    captureAndType('too dark')

    keyInBox({ key: 'Enter' })
    key('keyup', { key: 'Alt', altKey: false })

    expect(overlay.mounted).toBe(true)
  })

  it('leaves an untouched page with zero nodes, which is the half of B7 that survives', () => {
    // The scenario the guarantee was written for: a test run that never touches dogear. A
    // non-empty queue can only exist because someone clicked and typed, and it is in-memory
    // so a reload empties it.
    key('keydown', { key: 'Alt', altKey: true })
    key('keyup', { key: 'Alt', altKey: false })

    expect(session.queue.count).toBe(0)
    expect(overlay.mounted).toBe(false)
  })

  it('does not let the app see the keystroke that queued', () => {
    // Same hard stop Escape needs. An app with a global Enter handler — a form submit, a
    // command palette — must not act on the key that filed an annotation against it.
    const appKeys = vi.fn()
    window.addEventListener('keydown', appKeys)
    captureAndType('too dark')

    const event = keyInBox({ key: 'Enter' })

    expect(event.defaultPrevented).toBe(true)
    expect(appKeys).not.toHaveBeenCalled()

    window.removeEventListener('keydown', appKeys)
  })

  it('leaves Shift+Enter to the textarea, so a second line is typable', () => {
    captureAndType('first line')

    const event = keyInBox({ key: 'Enter', shiftKey: true })

    expect(session.queue.count).toBe(0)
    // Not cancelled — cancelling is what would stop the newline being inserted.
    expect(event.defaultPrevented).toBe(false)
    expect((overlay.root.querySelector('.box') as HTMLElement).hidden).toBe(false)
  })

  it.each([
    { text: '', why: 'an empty box' },
    { text: '   \n  ', why: 'whitespace only' },
  ])('queues nothing on Enter with $why, and keeps the box open', ({ text }) => {
    // Not a harmless placeholder: validateBatch rejects the *entire* batch on one empty
    // comment, so queueing this would take seven good annotations down with it at B5 (#12).
    captureAndType(text)

    const event = keyInBox({ key: 'Enter' })

    expect(session.queue.count).toBe(0)
    expect((overlay.root.querySelector('.box') as HTMLElement).hidden).toBe(false)
    // Still cancelled — inserting a newline instead would be a silent "no".
    expect(event.defaultPrevented).toBe(true)
  })

  it('queues nothing mid-IME, where Enter commits a candidate', () => {
    captureAndType('あ')

    keyInBox({ key: 'Enter', isComposing: true })

    expect(session.queue.count).toBe(0)
  })

  it("ignores Enter in the app's own fields while the box happens to be open", () => {
    // The host check. Without it, typing into a search box behind an open comment box would
    // file an annotation about whatever was last clicked.
    captureAndType('too dark')

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(event)

    expect(session.queue.count).toBe(0)
    expect(event.defaultPrevented).toBe(false)
  })

  it('queues nothing on Escape', () => {
    captureAndType('never mind')

    key('keydown', { key: 'Escape' })

    expect(session.queue.count).toBe(0)
    expect(overlay.mounted).toBe(false)
  })

  it('tears down to a byte-identical document even with a non-empty queue', () => {
    // The other half of the B7 narrowing: "while idle and the queue is empty" weakens the
    // idle guarantee, and must not weaken the teardown one. Asserted here rather than in
    // teardown.test.ts because that file drives `init()`, which returns only a teardown —
    // the shadow root is closed, so nothing outside can type a comment to fill the queue.
    const before = document.documentElement.outerHTML
    captureAndType('too dark')
    keyInBox({ key: 'Enter' })
    expect(overlay.mounted).toBe(true)

    registry.detachAll()
    overlay.destroy()

    expect(document.documentElement.outerHTML).toBe(before)
  })

  it('gives the comment box a hint line, since nothing else teaches Shift+Enter', () => {
    mouse('click', { altKey: true })

    expect(overlay.root.querySelector('.hint')?.textContent).toBe(HINT)
  })
})

describe('B4 — review before submit', () => {
  it('opens from the badge, lists the queue, and focuses the first row', () => {
    queueComment('too dark')
    queueComment('wrong copy')

    badge().click()

    expect(panelOpen()).toBe(true)
    expect(panelRows()).toHaveLength(2)
    expect(rowInput(0).value).toBe('too dark')
    expect(badge().getAttribute('aria-expanded')).toBe('true')
    // The host is what document.activeElement reports across a closed shadow boundary; the
    // assertion that means something is the one inside the root. See box.ts's focus().
    expect(overlay.root.activeElement).toBe(rowInput(0))
  })

  it('toggles shut on a second badge click', () => {
    queueComment('too dark')
    badge().click()

    badge().click()

    expect(panelOpen()).toBe(false)
    expect(badge().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Escape', () => {
    queueComment('too dark')
    badge().click()
    rowInput(0).blur()

    key('keydown', { key: 'Escape' })

    expect(panelOpen()).toBe(false)
  })

  it('gives Escape to the row being edited, not the panel', () => {
    // The ordered chain. A row owns Escape before the panel containing it does — otherwise
    // abandoning a typo would throw away the whole review.
    queueComment('too dark')
    badge().click()
    rowInput(0).value = 'typed over it'

    keyInBox({ key: 'Escape' })

    expect(rowInput(0).value).toBe('too dark')
    expect(panelOpen()).toBe(true)
  })

  it('commits an edit on Enter without the app seeing the key', () => {
    const appKeys = vi.fn()
    window.addEventListener('keydown', appKeys)
    queueComment('too dark')
    badge().click()
    rowInput(0).value = 'far too dark'

    const event = keyInBox({ key: 'Enter' })

    expect(firstQueued().comment).toBe('far too dark')
    expect(event.defaultPrevented).toBe(true)
    expect(appKeys).not.toHaveBeenCalled()

    window.removeEventListener('keydown', appKeys)
  })

  it('leaves Shift+Enter to the row, so a comment can gain a second line', () => {
    queueComment('too dark')
    badge().click()
    rowInput(0).value = 'first line'

    const event = keyInBox({ key: 'Enter', shiftKey: true })

    expect(event.defaultPrevented).toBe(false)
    expect(panelOpen()).toBe(true)
  })

  it('commits an edit on blur, so clicking away does not discard it', () => {
    queueComment('too dark')
    badge().click()
    rowInput(0).value = 'far too dark'

    rowInput(0).blur()

    expect(firstQueued().comment).toBe('far too dark')
  })

  it.each([
    { text: '', why: 'emptied' },
    { text: '   ', why: 'whitespace' },
  ])(
    'reverts a row $why rather than storing a comment the server rejects',
    ({ text }) => {
      queueComment('too dark')
      badge().click()
      rowInput(0).value = text

      keyInBox({ key: 'Enter' })

      expect(firstQueued().comment).toBe('too dark')
      expect(rowInput(0).value).toBe('too dark')
    },
  )

  it('deletes a row and decrements the badge', () => {
    queueComment('keep me')
    queueComment('drop me')
    badge().click()

    panelRows()[1]?.querySelector<HTMLButtonElement>('.item-drop')?.click()

    expect(session.queue.items.map((item) => item.comment)).toEqual(['keep me'])
    expect(panelRows()).toHaveLength(1)
    expect(badge().textContent).toBe('1 pending')
  })

  it('deleting the last item closes the panel and returns the document to zero nodes', () => {
    // B7's (#14) narrowed guarantee, reversing. The queue empties, so dogear leaves.
    const before = document.documentElement.outerHTML
    queueComment('the only one')
    badge().click()

    panelRows()[0]?.querySelector<HTMLButtonElement>('.item-drop')?.click()

    expect(panelOpen()).toBe(false)
    expect(overlay.mounted).toBe(false)
    expect(document.documentElement.outerHTML).toBe(before)
  })

  it('closes when a new element is captured — one surface at a time', () => {
    // "I spotted one more thing" mid-review is reasonable, so the gesture is not blocked.
    queueComment('too dark')
    badge().click()

    mouse('click', { altKey: true })

    expect(panelOpen()).toBe(false)
    expect((overlay.root.querySelector('.box') as HTMLElement).hidden).toBe(false)
  })

  it('closes an open comment box when it opens — the same rule, the other way', () => {
    queueComment('too dark')
    captureAndType('a second one, unfinished')

    badge().click()

    expect(panelOpen()).toBe(true)
    expect((overlay.root.querySelector('.box') as HTMLElement).hidden).toBe(true)
    // Abandoned, not queued — opening the panel is not a submit.
    expect(session.queue.count).toBe(1)
  })

  it('stays mounted while open even though nothing is being pointed at', () => {
    queueComment('too dark')
    badge().click()
    key('keyup', { key: 'Alt', altKey: false })

    expect(overlay.mounted).toBe(true)
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
