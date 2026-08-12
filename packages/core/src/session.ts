/**
 * B2 (#9) and B1 (#8) — the modifier state machine, the suppression set, and capture — plus
 * B3's (#10) queueing on Enter, B4's (#11) review panel, and B5's (#12) submit.
 *
 * Everything here attaches through the registry `init()` owns, so B6's (#13) "detach, don't
 * ignore" holds by construction rather than by discipline. See ./listeners.ts.
 *
 * **One surface at a time**, enforced in both directions: opening the panel releases a
 * captured element, and capturing one closes the panel. The comment box anchors to its target
 * and the panel sits bottom-right, so allowing both would mean two floating panes that can
 * land on top of each other — and the box's anchoring already has the viewport edges to dodge
 * without adding the panel to the list.
 */

import type { Badge } from './badge.js'
import { createBadge } from './badge.js'
import type { CommentBox } from './box.js'
import { createCommentBox } from './box.js'
import type { ElementDescription } from './describe.js'
import { describeElement, labelFor } from './describe.js'
import type { ListenerRegistry } from './listeners.js'
import type { Modifier, ResolvedOptions } from './options.js'
import type { Outline } from './outline.js'
import { createOutline, isPaintable } from './outline.js'
import type { Overlay } from './overlay.js'
import type { Panel } from './panel.js'
import { createPanel } from './panel.js'
import type { Queue } from './queue.js'
import { acceptableComment } from './queue.js'
import { buildBatch, submitBatch, SUBMIT_TIMEOUT_MS } from './submit.js'

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
  /**
   * The batch this tab is holding. Read-only in practice — nothing outside adds to it.
   *
   * Exposed so B3's (#10) first criterion can be tested against the annotation that was
   * actually assembled rather than against the badge's rendering of a count. It is not part
   * of `@dogear/core`'s public surface: `init()` returns a teardown, and ./index.ts exports
   * neither this type nor `createSession`.
   */
  readonly queue: Queue
  /**
   * Abort anything in flight and cancel pending timers. Called by `init()`'s teardown
   * **before** the listeners come off, so a late response cannot touch a dead overlay.
   *
   * Idempotent, like the teardown that calls it.
   */
  dispose(): void
}

export interface SessionDeps {
  readonly registry: ListenerRegistry
  readonly overlay: Overlay
  readonly options: ResolvedOptions
  /**
   * The batch, **owned from above** — see ./controller.ts.
   *
   * B6 (#13) moved it out of this closure. Everything else here dies with the session, and
   * the queue is the one thing that must not: it is the only copy of the user's work, so a
   * kill switch that destroyed it would either lose work or have to refuse to run.
   */
  readonly queue: Queue
  /**
   * B6 (#13) — the user asked dogear to turn off. Called at most once; whoever owns the
   * teardown acts on it. See ./init.ts.
   */
  readonly onDisable: () => void
}

/**
 * How long B5's (#12) `N sent` confirmation stays up before the badge reverts and the host
 * unmounts itself.
 *
 * Long enough to read, short enough that it is gone before you have done anything else —
 * which is what keeps B7's (#14) "zero nodes while idle and the queue is empty" true without
 * a second amendment. See the brief for why a *pending count* may not work this way and a
 * one-shot confirmation may.
 */
export const SENT_NOTICE_MS = 2_500

export function createSession({
  registry,
  overlay,
  options,
  queue,
  onDisable,
}: SessionDeps): Session {
  const { modifier, endpoint } = options

  const hover: Outline = createOutline()
  const captured: Outline = createOutline('captured')
  const box: CommentBox = createCommentBox()
  const badge: Badge = createBadge()
  // The panel mutates nothing itself — it reports, and this file applies. Same shape as
  // `capture()` below: one place owns the order of queue, badge, render and mount.
  const panel: Panel = createPanel({
    registry,
    handlers: {
      onDelete: (key) => {
        if (!queue.remove(key)) return

        badge.set(queue.count)
        // An empty queue means nothing left to review, so the review UI leaves with it and
        // the document returns to zero nodes. This is B7's (#14) narrowed guarantee being
        // visibly reversible, which is the property most worth being able to show by hand.
        if (queue.count === 0) closePanel()
        else panel.render(queue.items)

        sync()
      },
      onEdit: (key, raw) => {
        const comment = acceptableComment(raw)
        // Refused, not stored — same rule as Enter on an empty box, and for the same reason:
        // `validateBatch` rejects the whole batch on one empty comment. `cancelEdit` puts the
        // previous text back, so the row reverts rather than sitting there invalid.
        if (comment === null) {
          panel.cancelEdit()
          return
        }

        queue.update(key, comment)
      },
      onSubmit: () => void send(),
      onDisable: requestDisable,
    },
  })
  overlay.root.append(
    hover.element,
    captured.element,
    box.element,
    badge.element,
    panel.element,
  )

  // A batch that outlived a previous session — B6's (#13) disable/re-enable cycle, or a
  // console `stop()` followed by `start()`. The queue is handed in rather than created here,
  // so it can arrive non-empty, and the badge is the only thing that would say so.
  //
  // Unconditional: `badge.set(0)` hides it, and `sync()` on a fresh session with nothing
  // visible unmounts a host that was never mounted, which is a no-op. Spelling out the
  // empty case as a branch would buy nothing and add one.
  badge.set(queue.count)
  sync()

  let armed = false
  let pointerX = 0
  let pointerY = 0
  let capturedElement: Element | null = null
  /**
   * The description taken at the moment of capture, not at the moment of queueing.
   *
   * Held instead of the label string it renders, because it is also the annotation's
   * `element` payload. Re-describing at Enter would record whatever the app had re-rendered
   * into the element while the comment was being typed — and the text snippet is the
   * re-anchoring lifeline for an agent, so it has to be the text that was pointed at.
   */
  let capturedDescription: ElementDescription | null = null
  let frameScheduled = false
  /** Non-null while a POST is in flight. Aborted by {@link Session.dispose}. */
  let inFlight: AbortController | null = null
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

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

  /**
   * Mount when there is something to see, unmount when there is not. B7's (#14) third
   * guarantee, and the one line that narrows it.
   *
   * `badge.visible` is B3's (#10) amendment: the guarantee is now "zero nodes while idle
   * **and the queue is empty**". The scenario B7 was written for is untouched — a non-empty
   * queue can only exist because someone modifier-clicked and typed, and the queue is
   * in-memory so any reload empties it, so a test run that never touches dogear still sees a
   * byte-identical document. The alternative was a count visible only while the modifier is
   * held, which cannot tell you that you are carrying eight comments. See the brief.
   */
  function sync(): void {
    if (hover.visible || captured.visible || box.open || badge.visible || panel.open)
      overlay.mount()
    else overlay.unmount()
  }

  /**
   * Neither of these calls `sync()` — every caller does, and there are four of them. Same
   * split as `capture()` and `release()`: the thing that changes visibility does not also
   * decide whether the host stays in the document.
   */
  function openPanel(): void {
    // One surface at a time — see the module docblock. Releasing first also means `box.open`
    // and `panel.open` are mutually exclusive, which is what lets the Escape chain below stay
    // a chain rather than a matrix.
    release()
    panel.show(queue.items)
    badge.setExpanded(true)

    // Mounted before focusing, and explicitly rather than through `sync()`: focus does not
    // move to a detached element.
    overlay.mount()
    panel.focusFirst()
  }

  function closePanel(): void {
    panel.hide()
    badge.setExpanded(false)
  }

  function togglePanel(): void {
    if (panel.open) closePanel()
    else openPanel()

    sync()
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

    // The other direction of one-surface-at-a-time. "I spotted one more thing" mid-review is
    // a reasonable thought, so the gesture is not blocked — it just leaves review behind.
    closePanel()

    capturedElement = element
    capturedDescription = describeElement(element)
    captured.show(rect)
    hover.hide()

    // Mount before showing the box: `show` measures itself to decide whether to sit above
    // or below the target, and a detached element measures as zero.
    overlay.mount()
    box.show(rect, labelFor(capturedDescription), viewport())
    box.focus()
    sync()
  }

  function release(): void {
    capturedElement = null
    capturedDescription = null
    captured.hide()
    box.hide()
  }

  /**
   * B3's (#10) first criterion — turn what is captured plus what was typed into a queued
   * annotation. Returns whether anything was queued.
   *
   * **An empty comment is refused rather than queued** — see `acceptableComment`, which B4's
   * (#11) edit path shares so the two cannot drift.
   *
   * **No `id`, `status`, `createdAt` or `resolvedAt`.** The server owns all four — see
   * ./queue.ts.
   *
   * Releases on success rather than staying open on the same element: the workflow this
   * ticket exists for is eight comments across three pages, so the next thing you do is point
   * somewhere else. Same path as Escape, so queueing and dismissing share one set of
   * invariants.
   */
  function submit(): boolean {
    const comment = acceptableComment(box.value)
    if (comment === null || capturedDescription === null) return false

    queue.add({
      comment,
      element: capturedDescription,
      url: location.href,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
      },
      authoredAt: new Date().toISOString(),
    })

    badge.set(queue.count)
    release()
    return true
  }

  /**
   * B5 (#12) — drain the batch to disk. Named apart from `submit()` above, which queues one
   * annotation from the comment box; this is the one that leaves the tab.
   *
   * **The clear is keyed to what was sent, not to the queue.** Capturing an element closes
   * the panel (see `capture`), so a modifier-click during the flight adds an item that was
   * never in the batch — and `queue.items = []` on success would delete it. Keys exist for
   * exactly this: addressing by key rather than by position is what stops a concurrent
   * mutation re-pointing the operation at the wrong item. See ./queue.ts.
   *
   * **Nothing is cleared on anything but a confirmed 200.** The in-memory queue is the only
   * copy of the user's work, and it is the one thing in dogear that cannot be recovered.
   */
  async function send(): Promise<void> {
    if (inFlight !== null) return

    const items = queue.items
    if (items.length === 0) return

    // Cancel a pending revert before starting: two submits in quick succession would
    // otherwise leave the first one's timer to overwrite the second one's notice.
    clearNotice()
    panel.clearStatus()
    panel.setBusy(true)

    const keys = items.map((item) => item.key)
    const controller = new AbortController()
    inFlight = controller
    const timeout = setTimeout(() => {
      controller.abort()
    }, SUBMIT_TIMEOUT_MS)

    let result
    try {
      result = await submitBatch({
        endpoint,
        body: buildBatch(items, panel.note),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
      inFlight = null
    }

    // Torn down while we were waiting. Touching the overlay now would re-mount a host that
    // `destroy()` has already removed — the same one-frame window `init()`'s
    // detach-before-destroy ordering exists to close.
    if (disposed) return

    panel.setBusy(false)

    if (!result.ok) {
      panel.showError(result.reason)
      // The footer gets one line; the developer gets the rest. A 500 is a server-side
      // problem and the reason alone will not diagnose it.
      console.error('[dogear] submit failed:', result.reason, result.detail)
      return
    }

    for (const key of keys) queue.remove(key)
    panel.clearNote()
    closePanel()

    // Announced rather than set, then reverted on a timer — the panel has just closed, so
    // this is the only thing left saying the write happened.
    badge.announce(`${result.written} sent`)
    overlay.mount()
    noticeTimer = setTimeout(() => {
      noticeTimer = null
      badge.set(queue.count)
      sync()
    }, SENT_NOTICE_MS)
  }

  function clearNotice(): void {
    if (noticeTimer === null) return
    clearTimeout(noticeTimer)
    noticeTimer = null
  }

  /**
   * B6 (#13) — the toggle and the chord both land here.
   *
   * **It does not consult the queue, and that is the whole design.** An earlier version
   * refused while items were pending, because tearing the session down used to destroy the
   * batch with it. The queue is owned by ./controller.ts now and outlives the session, so
   * there is nothing to protect and nothing to refuse: disabling is instant, unconditional,
   * and lossless, and re-enabling brings the batch back with the badge already counting it.
   *
   * A kill switch that can decline is not really one. "Get out of my way" is the entire
   * request, and the version that answered "no, deal with your queue first" was solving a
   * problem we had chosen to have.
   *
   * The one guard left is a submit already in the air — see below.
   */
  function requestDisable(): void {
    // A sub-second window, and the only one that can cost anything. `dispose()` aborts the
    // request, but an abort is client-side: the POST may already have been written to disk,
    // and the local items are only cleared on a response we never read. Disabling here and
    // submitting again after a re-enable would put the same annotations in `queue.json`
    // twice. Silent rather than explained, because at localhost latency this is unhittable
    // in practice and a message would document a state nobody reaches.
    if (inFlight !== null) return

    onDisable()
  }

  // ---------------------------------------------------------------------------------
  // Listeners. Every one goes through the registry — see ./listeners.ts.
  // ---------------------------------------------------------------------------------

  /**
   * The badge is B4's (#11) handle for the panel.
   *
   * This listener is reachable because the suppression loop below returns early on
   * `event.target === overlay.host` — a click anywhere in the shadow root retargets to the
   * host on its way to window, so dogear's own UI is exempt from its own suppression and the
   * event proceeds to the target phase here.
   */
  registry.on(badge.element, 'click', togglePanel)

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
      // Escape is a chain, most-specific first, and the order is the whole of it: a row being
      // edited owns Escape before the panel containing it does. Every arm stops the event
      // hard, because an app that also closes a modal on Escape should not do it while dogear
      // has focus. B3's (#10) third criterion is the middle arm; it landed early during B1 so
      // the box was dismissable for the manual pass.
      if (event.key === 'Escape') {
        // B5's (#12) note is the new most-specific arm, ahead of a row edit. It has to be:
        // `panel.editing` is false while the note has focus (the note is in the footer, not
        // in a `.item`, so `keyOf` finds no row), which would otherwise send Escape straight
        // to `closePanel` and take a typed sentence with it.
        if (panel.noteEditing) panel.cancelNoteEdit()
        else if (panel.editing) panel.cancelEdit()
        else if (box.open) release()
        else if (panel.open) closePanel()
        else return

        sync()
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      // B6's (#13) kill switch. First of the chord arms and unconditional on what is open:
      // this is the one binding that has to work from anywhere, including mid-comment, since
      // its whole purpose is "get out of my way".
      //
      // `Ctrl+Alt+D`, sharing D4's (#23) `Ctrl+Alt` prefix so dogear's chords read as a
      // family. `event.code` rather than `event.key`: Alt is a compose modifier on macOS and
      // several Windows layouts, so `key` arrives as `'∂'` or a dead key rather than `'d'`,
      // while `code` reports the physical `KeyD` regardless of layout.
      //
      // Not guarded on `event.target === overlay.host` — unlike Enter and Escape, which are
      // ours only while our own UI has focus. This one is global by design; it is stopped
      // hard so an app binding on the same chord does not also fire.
      if (event.code === 'KeyD' && event.ctrlKey && event.altKey && !event.isComposing) {
        requestDisable()
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      // B5's (#12) keyboard path to submit. Before the two plain-Enter arms below, because
      // ⌘/Ctrl+Enter inside a row or the note would otherwise commit the edit and stop.
      //
      // Not bound to the box's Enter: submitting is a panel action, and requiring the panel
      // to be open is what keeps B4's (#11) review step unavoidable. `Ctrl+Alt+P` is
      // reserved for D4's (#23) clipboard export, so the two do not collide.
      if (
        event.key === 'Enter' &&
        (event.metaKey || event.ctrlKey) &&
        !event.isComposing &&
        panel.open &&
        event.target === overlay.host
      ) {
        // Commit whatever row is being edited first, so ⌘+Enter from inside a row sends the
        // text on screen rather than the last committed value.
        if (panel.editing) panel.commitEdit()
        void send()
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      // B4's (#11) in-place edit, committed on the same key and under the same guards as
      // B3's below — an app's global Enter handler has no more business seeing the key that
      // edited an annotation than the one that filed it.
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        panel.editing &&
        event.target === overlay.host
      ) {
        panel.commitEdit()
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      // B3's (#10) first criterion. Handled here rather than on the textarea so it inherits
      // the same hard stop Escape needs — an app with a global Enter handler (form submit, a
      // command palette) must not see the keystroke that queued an annotation.
      //
      // Three guards, and each rules out a real keypress:
      // - `event.target === overlay.host` — events from inside a closed shadow root retarget
      //   to the host by the time they reach window, so this is "Enter in *our* box" and not
      //   Enter in the app's search field while our box happens to be open. Same check the
      //   suppression loop makes below.
      // - `!event.shiftKey` — Shift+Enter is the newline. Falling through rather than
      //   cancelling is what lets the textarea insert it.
      // - `!event.isComposing` — mid-IME, Enter commits the candidate. Queueing there would
      //   submit a half-typed comment and eat the keystroke that was finishing the word.
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        box.open &&
        event.target === overlay.host
      ) {
        // Cancelled whether or not anything was queued: on the empty-comment path the box
        // stays open and focused, and inserting a newline there would be a silent "no".
        if (submit()) sync()
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

  return {
    refresh,
    queue,

    dispose() {
      if (disposed) return
      disposed = true

      clearNotice()
      // The `finally` in `send` clears `inFlight`, and the awaiting continuation then bails
      // on `disposed` — so aborting here is about not leaving a request open on a page that
      // is done with dogear, not about controlling what happens next.
      inFlight?.abort()
      inFlight = null
    },
  }
}
