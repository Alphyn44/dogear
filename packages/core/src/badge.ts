/**
 * B3 (#10) — the pending count.
 *
 * **This is the first thing dogear renders that outlives a gesture, and that costs B7 (#14)
 * something.** B7's third guarantee was "zero nodes in the document while idle"; a badge that
 * only appears while the modifier is held cannot tell you that you are carrying eight
 * comments, which is most of what a badge is for. So the guarantee narrows to *zero nodes
 * while idle **and the queue is empty***, and `session.ts`'s `sync()` is where that is
 * spelled out. The scenario B7 was written to protect is untouched: a non-empty queue only
 * exists because someone modifier-clicked and typed, and the queue is in-memory so a reload
 * empties it. See the brief's Decisions log.
 *
 * **It is the handle for B4's (#11) review panel**, and a real `<button>` rather than a
 * styled div — so it is focusable, reachable by keyboard, and announced as a control. It was
 * inert through B3 (#10) on the argument that a thing which looks clickable and does nothing
 * swallows app clicks in that corner; now that it does something, it opts back into pointer
 * events (see ./styles.ts) and that objection is spent.
 *
 * `aria-live` rather than `role="status"`: the count still needs announcing when it changes,
 * but a control that is *also* a live region is the wrong pairing — `role="status"` would
 * override the button role and the thing would stop being announced as operable. The
 * attribute form gives the announcement without touching the role.
 */

export interface Badge {
  readonly element: HTMLButtonElement
  /** True iff a count above zero is being shown. `sync()` reads this. */
  readonly visible: boolean
  /** Show `count`, or hide entirely at zero. */
  set(count: number): void
  /** Reflect whether the panel this opens is showing. */
  setExpanded(expanded: boolean): void
}

export function createBadge(): Badge {
  const element = document.createElement('button')
  element.className = 'badge'
  element.type = 'button'
  // Announced when the count changes. It lives inside a closed shadow root, which assistive
  // technology does traverse — closed affects scripted access, not the accessibility tree.
  element.setAttribute('aria-live', 'polite')
  element.setAttribute('aria-expanded', 'false')
  element.hidden = true

  return {
    element,

    get visible() {
      return !element.hidden
    },

    set(count) {
      // Not a bare integer: a lone number floating in the corner of someone's app is
      // cryptic, and the word is what makes it dogear's rather than the app's.
      element.textContent = `${count} pending`
      element.hidden = count <= 0
    },

    setExpanded(expanded) {
      element.setAttribute('aria-expanded', String(expanded))
    },
  }
}
