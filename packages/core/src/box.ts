/**
 * The comment box B1 (#8) opens on a captured element.
 *
 * Scope: it renders, it anchors, it takes focus, and you can type in it. **Enter (queue the
 * annotation) and the pending badge are B3 (#10)** — nothing typed here goes anywhere yet.
 *
 * Esc is the one exception, pulled forward from B3 deliberately: a box that cannot be
 * dismissed makes the whole manual verification pass — which is the only thing that can
 * settle B1 and B2's cross-browser criteria — unpleasant enough to cut corners on. Noted on
 * #10 so B3 is not closed against work that already landed.
 *
 * Anchoring is a pure function for the same reason the outline's is: happy-dom has no layout
 * engine, so the DOM-environment test can only say "styles were applied", and the arithmetic
 * needs real numbers.
 */

import type { Box } from './outline.js'

/** Distance from the target, and the minimum from any viewport edge. */
export const GAP = 8

export interface Viewport {
  readonly width: number
  readonly height: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Anchor {
  readonly left: string
  readonly top: string
}

/**
 * Place the box near `target` without letting it leave the viewport.
 *
 * Below the target by preference — that is where the eye already is after clicking, and it
 * does not cover what you just pointed at. Flipped above when below would overflow the
 * bottom. If neither fits (a target taller than the viewport), clamped, because a box half
 * off-screen is worse than one overlapping its target.
 *
 * Viewport-relative throughout, matching `position: fixed`. No scroll offsets — see
 * ./outline.ts.
 */
export function anchorStyle(
  target: Box,
  box: Size,
  viewport: Viewport,
  gap: number = GAP,
): Anchor {
  // `Math.max(gap, …)` on every upper bound: when the box is wider or taller than the
  // viewport the "maximum" position computes below the minimum, and an unguarded clamp
  // would then pin it to a negative coordinate — off-screen in the other direction.
  const left = clamp(target.x, gap, Math.max(gap, viewport.width - box.width - gap))

  const below = target.y + target.height + gap
  const above = target.y - box.height - gap

  const top =
    below + box.height <= viewport.height - gap
      ? below
      : above >= gap
        ? above
        : clamp(below, gap, Math.max(gap, viewport.height - box.height - gap))

  return { left: `${left}px`, top: `${top}px` }
}

export interface CommentBox {
  readonly element: HTMLElement
  readonly input: HTMLTextAreaElement
  readonly open: boolean
  /** Show the box anchored to `target`, labelled. Does not focus — see {@link CommentBox.focus}. */
  show(target: Box, label: string, viewport: Viewport): void
  /**
   * Re-run the anchoring against a moved target.
   *
   * Separate from {@link CommentBox.show} because this runs on every frame of a scroll:
   * re-setting the label would be wasted work, and re-focusing would fight the user for the
   * caret every time the page moved.
   */
  reanchor(target: Box, viewport: Viewport): void
  focus(): void
  hide(): void
}

export function createCommentBox(): CommentBox {
  const element = document.createElement('div')
  element.className = 'box'
  element.setAttribute('role', 'dialog')
  element.setAttribute('aria-label', 'dogear comment')
  element.hidden = true

  const label = document.createElement('div')
  label.className = 'label'

  const input = document.createElement('textarea')
  input.className = 'input'
  input.rows = 3
  input.placeholder = "What's wrong with this?"
  // TODO(dogear): B3 (#10) owns Enter — queue the annotation and clear the box.

  element.append(label, input)

  return {
    element,
    input,

    get open() {
      return !element.hidden
    },

    show(target, text, viewport) {
      label.textContent = text
      element.hidden = false
      this.reanchor(target, viewport)
    },

    reanchor(target, viewport) {
      // Measured after unhiding, because a `hidden` element has no box. The measurement is
      // of our own element inside the shadow root, so nothing about the app's layout is
      // read here beyond the target rect the caller already took.
      const rect = element.getBoundingClientRect()
      const anchor = anchorStyle(
        target,
        { width: rect.width, height: rect.height },
        viewport,
      )

      element.style.left = anchor.left
      element.style.top = anchor.top
    },

    focus() {
      // A closed shadow root does not obstruct programmatic focus. `document.activeElement`
      // will report the *host* — that is correct, it is how focus retargeting across a
      // shadow boundary is specified, and it is not a bug to be fixed. The assertion that
      // means something is `root.activeElement === input`.
      input.focus()
    },

    hide() {
      element.hidden = true
      input.value = ''
    },
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
