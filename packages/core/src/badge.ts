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
 * **Inert.** The host is `pointer-events: none` and this does not opt back in, so clicks pass
 * through to the app underneath. B4 (#11) turns it into the handle for the review panel and
 * adds both the handler and the `pointer-events` at the same time — a control that looks
 * clickable and does nothing would swallow app clicks in that corner, which for a dev tool
 * sitting underneath someone's interaction testing is a regression rather than a cosmetic
 * flaw. Exactly one thing in the shadow tree turns pointer events on today; see ./styles.ts.
 */

export interface Badge {
  readonly element: HTMLElement
  /** True iff a count above zero is being shown. `sync()` reads this. */
  readonly visible: boolean
  /** Show `count`, or hide entirely at zero. */
  set(count: number): void
}

export function createBadge(): Badge {
  const element = document.createElement('div')
  element.className = 'badge'
  // Announced when the count changes. It lives inside a closed shadow root, which assistive
  // technology does traverse — closed affects scripted access, not the accessibility tree.
  element.setAttribute('role', 'status')
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
  }
}
