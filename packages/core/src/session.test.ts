// @vitest-environment happy-dom

import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HINT } from './box.js'
import { createListenerRegistry, type ListenerRegistry } from './listeners.js'
import type { Modifier } from './options.js'
import { createOverlay, type Overlay } from './overlay.js'
import type { Queue, QueueItem } from './queue.js'
import { createQueue } from './queue.js'
import { createSession, isHeld, SENT_NOTICE_MS, type Session } from './session.js'

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
const ENDPOINT = '/__dogear'

let registry: ListenerRegistry
let overlay: Overlay
let session: Session
let target: HTMLElement
let appHandler: Mock<(event: Event) => void>
/** B6 (#13). The session reports the intent; the controller above it acts. */
let onDisable: Mock<() => void>

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

/**
 * Start a session over `queue`, defaulting to a fresh one.
 *
 * The queue is owned above the session since B6 (#13) — see ./controller.ts — so a test can
 * hand in a populated one to stand in for a batch that survived a disable.
 */
function start(modifier: Modifier = 'alt', existing?: Queue): void {
  registry = createListenerRegistry()
  overlay = createOverlay()
  onDisable = vi.fn<() => void>()
  session = createSession({
    registry,
    overlay,
    options: { modifier, endpoint: ENDPOINT, enabled: true },
    queue: existing ?? createQueue(),
    onDisable,
  })
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

// ---------------------------------------------------------------------------------
// B5 (#12). The footer, and a stubbed dev server.
// ---------------------------------------------------------------------------------

function noteInput(): HTMLTextAreaElement {
  return overlay.root.querySelector('.note') as HTMLTextAreaElement
}

function submitButton(): HTMLButtonElement {
  return overlay.root.querySelector('.submit') as HTMLButtonElement
}

function statusText(): string {
  return overlay.root.querySelector('.status')?.textContent ?? ''
}

function ok(counts: { written: number; pending: number }): Response {
  return new Response(
    JSON.stringify({ ok: true, ...counts, queuePath: '.dogear/queue.json' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function failure(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(response: Response | Error): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    ),
  )
}

/** What actually went over the wire on the most recent POST. */
function sentBody(): { note?: string; batch: { comment: string }[] } {
  const calls = vi.mocked(fetch).mock.calls
  const init = calls[calls.length - 1]?.[1] as RequestInit | undefined
  if (init === undefined) throw new Error('nothing was POSTed')
  return JSON.parse(String(init.body)) as { note?: string; batch: { comment: string }[] }
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
  // B5 (#12) stubs `fetch`. Left in place it would leak a resolved dev server into every
  // later file in the run.
  vi.unstubAllGlobals()
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
        // Present and empty: nothing in this fixture's ancestry is stamped, and C2 (#16)
        // sends `[]` rather than omitting the key so every queue item has one shape.
        sites: [],
        // C3's (#17) floor, in full. `selector` is always present — the fixture is a
        // `button.tab` alone in the body, so one segment identifies it — and `testId` is
        // absent as a key rather than null, because this element carries no test id.
        element: {
          tag: 'button',
          selector: 'button.tab',
          text: 'Settings',
          classes: ['tab'],
          id: null,
        },
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
      'sites',
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

  it('carries C3 (#17) — a selector that finds the element again', () => {
    // The floor, from the session's side. ./selector.test.ts owns what the string contains;
    // what matters here is that it reaches the payload and still resolves.
    captureAndType('too dark')

    keyInBox({ key: 'Enter' })

    const { selector } = firstQueued().element
    expect(selector).not.toBe('')
    expect(document.querySelector(selector)).toBe(target)
  })

  it('carries a test id when the element has one', () => {
    target.setAttribute('data-testid', 'settings-tab')

    captureAndType('too dark')
    keyInBox({ key: 'Enter' })

    expect(firstQueued().element.testId).toBe('settings-tab')
    // And the test id becomes the selector, since it outranks everything below an id.
    expect(firstQueued().element.selector).toBe('[data-testid="settings-tab"]')
  })

  it('carries C2 (#16) — the chain of the element that was clicked', () => {
    // The end of the localization ladder, from the session's side: `collectSites` is proved
    // in ./sites.test.ts, and this is the wiring — capture reads the DOM, commit sends it.
    const wrapper = document.createElement('nav')
    wrapper.setAttribute('data-dogear-src', 'src/TabBar.tsx:22:5')
    wrapper.setAttribute('data-dogear-component', 'TabBar')
    target.setAttribute('data-dogear-src', 'src/Button.tsx:20:5')
    target.setAttribute('data-dogear-component', 'Button')
    target.before(wrapper)
    wrapper.append(target)

    captureAndType('shade this darker')
    keyInBox({ key: 'Enter' })

    expect(firstQueued().sites).toEqual([
      {
        file: 'src/Button.tsx',
        line: 20,
        column: 5,
        tag: 'button',
        component: 'Button',
        via: 'attribute',
      },
      {
        file: 'src/TabBar.tsx',
        line: 22,
        column: 5,
        tag: 'nav',
        component: 'TabBar',
        via: 'attribute',
      },
    ])
  })

  it('resolves the chain at capture, not at Enter', () => {
    // The same argument the element description makes one test above, for the same reason:
    // the two are views of one element and must not disagree. HMR replacing the subtree
    // mid-comment is what this protects against — `refresh()` releases a disconnected
    // element, but only on the next frame.
    target.setAttribute('data-dogear-src', 'src/Button.tsx:20:5')

    captureAndType('too dark')
    target.setAttribute('data-dogear-src', 'src/Somewhere.tsx:99:1')

    keyInBox({ key: 'Enter' })

    expect(firstQueued().sites[0]?.file).toBe('src/Button.tsx')
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

/**
 * B5 (#12) — submit.
 *
 * ./submit.test.ts owns the wire: what the body looks like and how each server answer maps
 * to a result. What is left here is the **ordering**, which is where the losable mistakes
 * are — which items get cleared, when the note goes, and what happens to work that arrived
 * while the request was in the air.
 */
describe('B5 — batch submit', () => {
  /** Resolve every pending submit and let the session act on it. */
  async function settle(): Promise<void> {
    await vi.waitFor(() => {
      expect(submitButton().disabled).toBe(false)
    })
  }

  beforeEach(() => {
    // Silenced, not asserted away: the failure path deliberately logs, and a passing suite
    // should not print stack traces. The tests that care assert on the spy.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetch(ok({ written: 2, pending: 2 }))
  })

  it('POSTs the whole batch to the configured endpoint', async () => {
    queueComment('too dark')
    queueComment('wrong copy')
    badge().click()

    submitButton().click()
    await settle()

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? []
    expect(url).toBe('/__dogear/annotations')
    const body = JSON.parse(String((init as RequestInit).body)) as {
      version: number
      batch: { comment: string }[]
    }
    expect(body.version).toBe(1)
    expect(body.batch.map((item) => item.comment)).toEqual(['too dark', 'wrong copy'])
  })

  it('clears the local queue and closes the panel on a confirmed write', async () => {
    queueComment('too dark')
    queueComment('wrong copy')
    badge().click()

    submitButton().click()
    await settle()

    expect(session.queue.count).toBe(0)
    expect(panelOpen()).toBe(false)
  })

  it('confirms with a badge that then takes itself away', async () => {
    // The whole reason B7's (#14) third guarantee did not need amending a second time: the
    // confirmation is one-shot and unmounts on its own, with no interaction.
    const before = document.documentElement.outerHTML

    // Faked from the start, so the revert timer the session schedules is one this test can
    // wind forward. Only the timer functions — `requestAnimationFrame` drives the session's
    // frame coalescing and is left alone.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      queueComment('too dark')
      queueComment('wrong copy')
      badge().click()

      submitButton().click()
      await vi.waitFor(() => {
        expect(badge().textContent).toBe('2 sent')
      })
      expect(overlay.mounted).toBe(true)

      vi.advanceTimersByTime(SENT_NOTICE_MS)

      expect(overlay.mounted).toBe(false)
      expect(document.documentElement.outerHTML).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends the note and clears it once written', async () => {
    queueComment('too dark')
    badge().click()
    noteInput().value = '  all on the settings page  '

    submitButton().click()
    await settle()

    expect(sentBody().note).toBe('all on the settings page')
    expect(noteInput().value).toBe('')
  })

  it('omits the note entirely when none was typed', async () => {
    queueComment('too dark')
    badge().click()

    submitButton().click()
    await settle()

    expect('note' in sentBody()).toBe(false)
  })

  it('keeps every item and the note when the POST fails', async () => {
    // The criterion the ticket says matters more than the success path: the in-memory queue
    // is the only copy, so it is cleared on a confirmed 200 and on nothing else.
    stubFetch(failure(500, { ok: false, error: 'queue.json is not valid JSON' }))
    queueComment('too dark')
    queueComment('wrong copy')
    badge().click()
    noteInput().value = 'keep me'

    submitButton().click()
    await settle()

    expect(session.queue.count).toBe(2)
    expect(panelOpen()).toBe(true)
    expect(noteInput().value).toBe('keep me')
  })

  it('surfaces the reason in the panel and the detail on the console', async () => {
    stubFetch(
      failure(400, {
        ok: false,
        errors: ['batch[0].comment must be a non-empty string'],
      }),
    )
    queueComment('too dark')
    badge().click()

    submitButton().click()
    await settle()

    expect(statusText()).toContain('batch[0].comment must be a non-empty string')
    expect(console.error).toHaveBeenCalled()
  })

  it('says the dev server is unreachable rather than blaming the batch', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    queueComment('too dark')
    badge().click()

    submitButton().click()
    await settle()

    expect(statusText()).toContain('Could not reach the dev server')
  })

  it('lets a retry succeed after a failure, with nothing lost', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    queueComment('too dark')
    badge().click()
    submitButton().click()
    await settle()

    stubFetch(ok({ written: 1, pending: 1 }))
    submitButton().click()
    await settle()

    expect(session.queue.count).toBe(0)
  })

  it('clears a stale failure when the next submit starts', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    queueComment('too dark')
    badge().click()
    submitButton().click()
    await settle()
    expect(statusText()).not.toBe('')

    stubFetch(ok({ written: 1, pending: 1 }))
    submitButton().click()
    await settle()

    expect(statusText()).toBe('')
  })

  it('keeps an item captured while the request was in flight', async () => {
    // The reason the clear is keyed to what was *sent*. Capturing closes the panel, so a
    // modifier-click mid-flight adds an item that was never in the batch — and clearing the
    // queue wholesale on success would delete it.
    let release: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    )

    queueComment('too dark')
    badge().click()
    submitButton().click()

    queueComment('spotted one more')
    expect(session.queue.count).toBe(2)

    release(ok({ written: 1, pending: 1 }))
    await vi.waitFor(() => {
      expect(session.queue.count).toBe(1)
    })

    expect(session.queue.items[0]?.comment).toBe('spotted one more')
  })

  it('will not send the same batch twice from a double click', async () => {
    let release: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    )

    queueComment('too dark')
    badge().click()
    submitButton().click()
    submitButton().click()

    release(ok({ written: 1, pending: 1 }))
    await vi.waitFor(() => {
      expect(session.queue.count).toBe(0)
    })

    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does nothing on an empty queue', async () => {
    badge().click()

    submitButton().click()
    await Promise.resolve()

    expect(fetch).not.toHaveBeenCalled()
  })

  it('submits on Ctrl+Enter while the panel is open', async () => {
    queueComment('too dark')
    badge().click()

    keyInBox({ key: 'Enter', ctrlKey: true })
    await settle()

    expect(fetch).toHaveBeenCalledOnce()
    expect(session.queue.count).toBe(0)
  })

  it('submits on Meta+Enter too — the same key on the other platform', async () => {
    queueComment('too dark')
    badge().click()

    keyInBox({ key: 'Enter', metaKey: true })
    await settle()

    expect(fetch).toHaveBeenCalledOnce()
  })

  it('commits the row being edited before sending it', async () => {
    // Otherwise ⌘+Enter from inside a row sends the last committed value and silently drops
    // the text on screen.
    queueComment('too dark')
    badge().click()
    rowInput(0).focus()
    rowInput(0).value = 'actually, too light'

    keyInBox({ key: 'Enter', ctrlKey: true })
    await settle()

    expect(sentBody().batch[0]?.comment).toBe('actually, too light')
  })

  it('ignores Ctrl+Enter when the panel is shut — review is not skippable', async () => {
    queueComment('too dark')

    keyInBox({ key: 'Enter', ctrlKey: true })
    await Promise.resolve()

    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops the submit keystroke reaching the app', async () => {
    queueComment('too dark')
    badge().click()

    const event = keyInBox({ key: 'Enter', ctrlKey: true })
    await settle()

    expect(event.defaultPrevented).toBe(true)
  })
})

describe('B5 — the note in the Escape chain', () => {
  beforeEach(() => {
    queueComment('too dark')
    badge().click()
  })

  it('reverts the note and keeps the panel open', () => {
    // `panel.editing` is false while the note has focus — it is in the footer, not a row — so
    // without its own arm this Escape would close the panel and take the sentence with it.
    noteInput().value = 'committed'
    noteInput().focus()
    noteInput().value = 'half-typed'

    keyInBox({ key: 'Escape' })

    expect(noteInput().value).toBe('committed')
    expect(panelOpen()).toBe(true)
  })

  it('closes the panel on a second Escape, once the note has let go', () => {
    noteInput().focus()
    keyInBox({ key: 'Escape' })

    keyInBox({ key: 'Escape' })

    expect(panelOpen()).toBe(false)
  })

  it('leaves a row edit to the row, not to the note', () => {
    rowInput(0).focus()
    rowInput(0).value = 'changed'

    keyInBox({ key: 'Escape' })

    expect(rowInput(0).value).toBe('too dark')
    expect(panelOpen()).toBe(true)
  })
})

describe('B5 — teardown during a submit', () => {
  it('leaves the document untouched when stop() lands mid-flight', async () => {
    // The continuation would otherwise re-mount the host to show `N sent`, on a page that is
    // done with dogear — which is exactly what init()'s dispose-before-detach ordering closes.
    const before = document.documentElement.outerHTML
    let release: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    )

    queueComment('too dark')
    badge().click()
    submitButton().click()

    session.dispose()
    registry.detachAll()
    overlay.destroy()

    release(ok({ written: 1, pending: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.documentElement.outerHTML).toBe(before)
  })
})

/**
 * B6 (#13) — the kill switch, from the session's side.
 *
 * The session neither tears down nor persists: it decides whether the request is *allowed*
 * and reports it. ./controller.test.ts owns what happens next.
 */
describe('B6 — the kill switch', () => {
  function chord(init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyD',
      key: 'd',
      ctrlKey: true,
      altKey: true,
      ...init,
    })
    window.dispatchEvent(event)
    return event
  }

  function disableButton(): HTMLButtonElement {
    return overlay.root.querySelector('.disable') as HTMLButtonElement
  }

  it('reports the intent on Ctrl+Alt+D', () => {
    chord()

    expect(onDisable).toHaveBeenCalledOnce()
  })

  it('works with nothing open, which is the state it exists for', () => {
    // Unlike Enter and Escape, this one is not guarded on our own UI having focus. Its whole
    // purpose is "get out of my way", so it has to work from a cold page.
    expect(overlay.mounted).toBe(false)

    chord()

    expect(onDisable).toHaveBeenCalledOnce()
  })

  it('works mid-comment', () => {
    captureAndType('half a thought')

    chord()

    expect(onDisable).toHaveBeenCalledOnce()
  })

  it('keeps the keystroke away from the app', () => {
    const event = chord()

    expect(event.defaultPrevented).toBe(true)
  })

  it('reports from the panel button too', () => {
    queueComment('too dark')
    badge().click()

    disableButton().click()

    expect(onDisable).toHaveBeenCalledOnce()
  })

  it('uses code, not key — Alt is a compose modifier on several layouts', () => {
    // On macOS Alt+D arrives as `key: '∂'`, and on some Windows layouts as a dead key. Only
    // `code` reports the physical KeyD regardless.
    chord({ key: '∂' })

    expect(onDisable).toHaveBeenCalledOnce()
  })

  it.each([
    { why: 'Ctrl alone', init: { altKey: false } },
    { why: 'Alt alone', init: { ctrlKey: false } },
    { why: 'a different letter', init: { code: 'KeyF' } },
    { why: 'mid-IME composition', init: { isComposing: true } },
  ])('ignores $why', ({ init }) => {
    chord(init)

    expect(onDisable).not.toHaveBeenCalled()
  })

  describe('with unsent items', () => {
    beforeEach(() => {
      queueComment('too dark')
    })

    it('does not refuse — the queue outlives the session now', () => {
      // The earlier design blocked here, because tearing down destroyed the batch. The queue
      // is owned by ./controller.ts since, so there is nothing to protect and nothing to
      // refuse. A kill switch that can decline is not really one.
      chord()

      expect(onDisable).toHaveBeenCalledOnce()
    })

    it('leaves the batch untouched on its way out', () => {
      // The session does not clear, submit or discard anything. ./controller.test.ts proves
      // the other half — that the items are still there after the teardown.
      queueComment('wrong copy')

      chord()

      expect(session.queue.count).toBe(2)
      expect(session.queue.items.map((item) => item.comment)).toEqual([
        'too dark',
        'wrong copy',
      ])
    })

    it('says nothing, because there is nothing to explain', () => {
      chord()

      expect(statusText()).toBe('')
    })

    it('holds off while a submit is in flight', () => {
      // The one guard left, and it is not about losing work — `dispose()` aborts the request
      // and the items are only cleared on a response. It is about *duplicates*: the POST may
      // already be on disk, and re-enabling then submitting again would write it twice.
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>(() => {})),
      )
      badge().click()
      submitButton().click()

      chord()

      expect(onDisable).not.toHaveBeenCalled()
    })

    it('goes through once that submit has landed', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      stubFetch(ok({ written: 1, pending: 1 }))
      badge().click()
      submitButton().click()
      await vi.waitFor(() => {
        expect(session.queue.count).toBe(0)
      })

      chord()

      expect(onDisable).toHaveBeenCalledOnce()
    })
  })

  describe('adopting a batch that survived a disable', () => {
    it('shows the count the moment the session comes back', () => {
      // What a re-enable looks like from the session's side: it is handed a populated queue
      // and has to say so, or the batch is invisible until you happen to modifier-click.
      const carried = createQueue()
      carried.add({
        comment: 'from before the disable',
        sites: [],
        element: {
          tag: 'button',
          selector: 'button',
          id: null,
          classes: [],
          text: 'Save',
        },
        url: 'http://localhost:5173/',
        viewport: { w: 1512, h: 945, dpr: 2 },
        authoredAt: '2026-08-12T10:00:00.000Z',
      })

      registry.detachAll()
      overlay.destroy()
      start('alt', carried)

      expect(badge().textContent).toBe('1 pending')
      expect(overlay.mounted).toBe(true)
    })

    it('renders the carried items when the panel opens', () => {
      const carried = createQueue()
      carried.add({
        comment: 'from before the disable',
        sites: [],
        element: {
          tag: 'button',
          selector: 'button',
          id: null,
          classes: [],
          text: 'Save',
        },
        url: 'http://localhost:5173/',
        viewport: { w: 1512, h: 945, dpr: 2 },
        authoredAt: '2026-08-12T10:00:00.000Z',
      })

      registry.detachAll()
      overlay.destroy()
      start('alt', carried)
      badge().click()

      expect(rowInput(0).value).toBe('from before the disable')
    })

    it('stays invisible for an empty one — B7 (#14) is untouched', () => {
      const before = document.documentElement.outerHTML
      registry.detachAll()
      overlay.destroy()

      start('alt', createQueue())

      expect(overlay.mounted).toBe(false)
      expect(document.documentElement.outerHTML).toBe(before)
    })
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
