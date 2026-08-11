/**
 * B2 (#9) and B1 (#8) — the modifier state machine, the suppression set, and capture.
 *
 * Everything here attaches through the registry `init()` owns, so B6's (#13) "detach, don't
 * ignore" holds by construction rather than by discipline. See ./listeners.ts.
 */

import type { CommentBox } from './box.js'
import { createCommentBox } from './box.js'
import { describeElement, labelFor } from './describe.js'
import type { ListenerRegistry } from './listeners.js'
import type { Modifier, ResolvedOptions } from './options.js'
import type { Outline } from './outline.js'
import { createOutline, isPaintable } from './outline.js'
import type { Overlay } from './overlay.js'

/** The `MouseEvent`/`KeyboardEvent` flag each modifier is carried on. */
const MODIFIER_FLAG = {
  alt: 'altKey',
  ctrl: 'ctrlKey',
  meta: 'metaKey',
  shift: 'shiftKey',
} as const satisfies Record<Modifier, keyof ModifierState>

/** The `KeyboardEvent.key` value each modifier's own key reports. */
const MODIFIER_KEY = {
  alt: 'Alt',
  ctrl: 'Control',
  meta: 'Meta',
  shift: 'Shift',
} as const satisfies Record<Modifier, string>

/**
 * Every event suppressed while the modifier is held, and why each is in the list.
 *
 * All are `MouseEvent` subclasses, which is what lets one handler serve them all.
 *
 * - `pointerdown`/`pointerup` — modern UI kits (Radix, Headless UI, drag libraries) act on
 *   pointerdown, not click. Miss these and a dropdown opens underneath the comment box.
 * - `mousedown`/`mouseup` — `preventDefault` on mousedown is what stops focus moving and a
 *   text selection starting, both of which fight the comment box.
 * - `click` — the criterion's literal event, and where the capture work happens.
 * - `auxclick` — middle and right click while armed.
 * - `dblclick` — a fast double modifier-click must not reach the app.
 * - `contextmenu` — mandatory under `modifier: 'ctrl'` on macOS, where Ctrl+click *is* the
 *   context menu.
 * - `dragstart` — alt-dragging an image starts a native drag in Chrome and Firefox.
 */
const SUPPRESSED = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
  'dragstart',
] as const

interface ModifierState {
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

/**
 * Is the arming modifier down *according to this event*?
 *
 * Reading the flag off the event rather than off our own bookkeeping is what removes a whole
 * class of stuck-modifier bugs: every mouse and keyboard event carries the current state, so
 * one shared handler on keydown and keyup needs no `event.key === 'Alt'` special case, and
 * any pointer event that arrives with the flag clear silently corrects a state we got wrong.
 *
 * Structurally typed so the tests can pass plain object literals with no DOM involved.
 */
export function isHeld(event: ModifierState, modifier: Modifier): boolean {
  return event[MODIFIER_FLAG[modifier]]
}

export interface Session {
  /**
   * Re-pick the target under the last known pointer position, re-measure, re-position.
   *
   * Public because scroll and resize drive it through a frame-coalescing wrapper, and the
   * tests drive it directly rather than waiting on `requestAnimationFrame`.
   */
  refresh(): void
}

export interface SessionDeps {
  readonly registry: ListenerRegistry
  readonly overlay: Overlay
  readonly options: ResolvedOptions
}

export function createSession({ registry, overlay, options }: SessionDeps): Session {
  const { modifier } = options

  const hover: Outline = createOutline()
  const captured: Outline = createOutline('captured')
  const box: CommentBox = createCommentBox()
  overlay.root.append(hover.element, captured.element, box.element)

  let armed = false
  let pointerX = 0
  let pointerY = 0
  let capturedElement: Element | null = null
  let capturedLabel = ''
  let frameScheduled = false

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight }
  }

  /**
   * What is under (x, y), ignoring ourselves.
   *
   * `elementFromPoint` rather than `event.target`, for three reasons that all matter: it
   * answers when the modifier is pressed with no pointer motion at all (B2's "holding Alt
   * outlines the element under the cursor" is false for a stationary cursor otherwise), it
   * re-answers correctly after a scroll moved something else under a stationary cursor, and
   * it does not vary with where the listener happens to be attached.
   *
   * The host check is the shadow-retarget guard. The host is `pointer-events: none` so it is
   * skipped entirely most of the time, but the comment box turns them back on — and a hit
   * inside a closed shadow root retargets to the host. Without this, hovering the box would
   * outline the overlay.
   */
  function elementAt(x: number, y: number): Element | null {
    const found = document.elementFromPoint(x, y)
    return found === null || found === overlay.host ? null : found
  }

  /** Mount when there is something to see, unmount when there is not. B7's second guarantee. */
  function sync(): void {
    if (hover.visible || captured.visible || box.open) overlay.mount()
    else overlay.unmount()
  }

  function refresh(): void {
    if (capturedElement !== null) {
      if (!capturedElement.isConnected) {
        // HMR replaced the subtree under us. Nothing to point at any more, and a frame
        // frozen over where the element used to be is worse than none.
        release()
      } else {
        const rect = capturedElement.getBoundingClientRect()
        captured.show(rect)
        if (box.open) box.reanchor(rect, viewport())
      }
    }

    if (armed) {
      const target = elementAt(pointerX, pointerY)
      if (target === null) hover.hide()
      else hover.show(target.getBoundingClientRect())
    } else {
      hover.hide()
    }

    sync()
  }

  /**
   * Coalesce to one refresh per frame.
   *
   * Momentum scrolling fires far faster than the display, and each refresh does a hit test
   * plus a measurement. There is deliberately no permanent `requestAnimationFrame` loop —
   * that would cost CPU on every page in every tab for the sake of tracking CSS animations,
   * which is a trade a dev tool should not make silently. The known consequence: an element
   * moved by an animation is not followed.
   */
  function scheduleRefresh(): void {
    if (frameScheduled) return
    frameScheduled = true
    requestAnimationFrame(() => {
      frameScheduled = false
      refresh()
    })
  }

  function setArmed(next: boolean): void {
    if (armed === next) return
    armed = next
    refresh()
  }

  function capture(element: Element): void {
    const rect = element.getBoundingClientRect()
    // Nothing to point at — an element with no boxes. Better to do nothing than to open a
    // box anchored to a point.
    if (!isPaintable(rect)) return

    capturedElement = element
    capturedLabel = labelFor(describeElement(element))
    captured.show(rect)
    hover.hide()

    // Mount before showing the box: `show` measures itself to decide whether to sit above
    // or below the target, and a detached element measures as zero.
    overlay.mount()
    box.show(rect, capturedLabel, viewport())
    box.focus()
    sync()
  }

  function release(): void {
    capturedElement = null
    capturedLabel = ''
    captured.hide()
    box.hide()
  }

  // ---------------------------------------------------------------------------------
  // Listeners. Every one goes through the registry — see ./listeners.ts.
  // ---------------------------------------------------------------------------------

  /**
   * Always on, even while disarmed, and `passive` because it never cancels anything.
   *
   * This is what makes "hold Alt and the element under the cursor outlines" true without
   * jiggling the mouse first: by the time the key goes down, the position is already known.
   */
  registry.on(
    window,
    'pointermove',
    (event) => {
      pointerX = event.clientX
      pointerY = event.clientY

      const held = isHeld(event, modifier)

      // The common case by a wide margin — an ordinary mouse moving across an idle page.
      // Record the position and do nothing else, so dogear costs a two-field assignment
      // per event rather than a hit test.
      if (!held && !armed && !hover.visible) return

      // Not `setArmed`, which only refreshes on a *change*. Moving the pointer while already
      // armed is the whole of B2 — the outline has to follow the cursor from one element to
      // the next, and a change-guarded refresh would leave it stuck on the first one.
      armed = held
      refresh()
    },
    { capture: true, passive: true },
  )

  registry.on(
    window,
    'keydown',
    (event) => {
      if (event.key === 'Escape' && box.open) {
        // Pulled forward from B3 (#10) so the box is dismissable. Stopped hard, because an
        // app that also closes a modal on Escape should not do it while dogear has focus.
        release()
        sync()
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      setArmed(isHeld(event, modifier))

      // Firefox reveals its menu bar on a lone Alt press (Windows and Linux). Cancelling the
      // keydown suppresses that — but only while dogear is visibly doing something.
      // Cancelling unconditionally would take the browser's own menu key away from the user
      // for as long as the page had focus, which is not ours to do.
      if (
        armed &&
        event.key === MODIFIER_KEY[modifier] &&
        (hover.visible || captured.visible)
      ) {
        event.preventDefault()
      }
    },
    { capture: true },
  )

  registry.on(
    window,
    'keyup',
    (event) => {
      const wasShowing = armed && (hover.visible || captured.visible)

      // Two conditions, not one. On a correct keyup of the modifier itself the flag is
      // already false — the released key is excluded from its own keyup's modifier state —
      // so `!isHeld` is the normal path. The `key` check is insurance against an engine that
      // reports it the other way; two lines to be immune to a browser lying, and a stuck
      // modifier means the outline never clears and every click gets eaten.
      if (!isHeld(event, modifier) || event.key === MODIFIER_KEY[modifier])
        setArmed(false)

      // Chrome and Edge activate their menu/toolbar on the modifier's *keyup*, not its
      // keydown — which is why cancelling the keydown (above) suppresses Firefox's menu bar
      // but not theirs. Guarded on what was showing *before* the disarm, and only for the
      // modifier's own key, so a lone Alt press on a page dogear is idle on still reaches
      // the browser's menu. Taking that away permanently is not ours to do.
      if (wasShowing && event.key === MODIFIER_KEY[modifier]) event.preventDefault()
    },
    { capture: true },
  )

  /**
   * There is deliberately **no `window` blur listener**, and the reason is the whole gesture.
   *
   * An earlier version disarmed on blur, as a defence against Alt+Tab delivering the keydown
   * and never the keyup. It is the wrong trade on the platform dogear has to work on: on
   * Windows, pressing Alt moves focus to the browser's own menu or toolbar in Chrome, Edge,
   * and Firefox alike — which fires `blur` on the window *as a direct consequence of the key
   * dogear is bound to*. The outline would appear and be torn down in the same breath, and
   * the tool would read as doing nothing at all.
   *
   * Dropping it costs almost nothing, because nothing important is keyed off `armed`:
   *
   * - **Suppression does not consult it.** Every handler in SUPPRESSED reads the modifier
   *   flag off its own event, so a stuck `armed` cannot eat a single click.
   * - **The outline is cosmetic**, and the next pointer or key event re-derives `armed` from
   *   that event's own flag — the self-correcting property the state machine is built on.
   * - **A genuinely hidden page is still covered**, by `visibilitychange` below.
   *
   * So the worst case is a stale outline drawn on an unfocused window nobody is looking at,
   * cleared by the first event after they come back.
   */

  /** Switching tabs does not always blur the window, and a hidden page should draw nothing. */
  registry.on(document, 'visibilitychange', () => {
    if (document.hidden) setArmed(false)
  })

  // `capture` is how a scroll inside a nested scroller is seen at all: scroll events from
  // an element do not bubble to window.
  registry.on(window, 'scroll', scheduleRefresh, { capture: true, passive: true })
  registry.on(window, 'resize', scheduleRefresh)

  for (const type of SUPPRESSED) {
    registry.on(
      window,
      type,
      (event: MouseEvent) => {
        // Our own comment box. Events from inside a closed shadow root retarget to the host
        // by the time they reach window, so this one check covers the whole overlay — and
        // without it, modifier-clicking into the textarea would cancel its own focus.
        if (event.target === overlay.host) return

        if (!isHeld(event, modifier)) return

        // `preventDefault` is not redundant with stopping propagation: it is the only thing
        // that cancels the *browser's own* modifier-click behaviour — Firefox's "save link",
        // Chrome's "download link", Cmd+click's "open in new tab".
        event.preventDefault()

        // We are the first node in the capture path, so plain `stopPropagation` would
        // already prevent this reaching document, <html>, <body>, and the target in both
        // phases — every handler the app attached to any element is dead either way. The
        // immediate form additionally kills other window-capture listeners registered after
        // ours, which is the difference between "no app handler ran" and "the app's global
        // click handler ran anyway". During a dogear gesture, nothing else should run.
        event.stopImmediatePropagation()

        if (event.type !== 'click') return

        // Acted on here rather than on mousedown, so the gesture keeps down-and-up-on-the-
        // same-element semantics. `preventDefault` on pointerdown/mousedown cancels focus
        // and selection but does *not* cancel the synthesised click, so this still fires.
        pointerX = event.clientX
        pointerY = event.clientY

        const target = elementAt(event.clientX, event.clientY)
        if (target !== null) capture(target)
      },
      { capture: true },
    )
  }

  return { refresh }
}
