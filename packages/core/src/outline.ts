/**
 * The frame drawn around a pointed-at element — B2 (#9) while the modifier is held, and
 * B1 (#8) once one is captured.
 *
 * The geometry is a pure function, deliberately separated from the element that consumes it.
 * happy-dom has no layout engine, so `getBoundingClientRect()` there returns all zeros and
 * no DOM-environment test can say anything useful about where the outline lands. Splitting
 * the arithmetic out gives it a real test in the node environment, and leaves the DOM half
 * with only "did the right styles get applied", which happy-dom answers fine. What neither
 * can settle — whether the frame visually lands on the element in a real browser — is why
 * the manual verification pass exists.
 */

/**
 * A viewport-relative rectangle. Structurally a subset of `DOMRect`, so a rect can be passed
 * straight in.
 */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface OutlineStyle {
  readonly transform: string
  readonly width: string
  readonly height: string
}

/** Coordinates are rounded to this many decimals, so a fractional rect stays sub-pixel accurate without dragging float noise into test tables. */
const PRECISION = 2

/**
 * Is there anything here worth drawing a frame around?
 *
 * A zero-area rect is what `getBoundingClientRect()` returns for `display: none`, for an
 * inline element that generated no boxes, and for an empty inline. Outlining nothing draws a
 * 2px dot in the corner of the viewport, which reads as a bug.
 */
export function isPaintable(box: Box): boolean {
  return box.width > 0 && box.height > 0
}

/**
 * Turn a viewport-relative box into the styles that frame it.
 *
 * **There is no scroll arithmetic anywhere in dogear, and this is why.**
 * `getBoundingClientRect()` returns viewport-relative coordinates and `position: fixed`
 * resolves against the viewport, so the two are already in the same coordinate space. The
 * instinct to add `scrollY` is the single most common way to get this wrong.
 *
 * `transform: translate3d` rather than `top`/`left`: a transform is a composited property
 * that skips layout invalidation entirely, and this runs on every frame of a scroll. The
 * `0` z-component is what opts into GPU compositing on engines that still key off the 3D
 * form.
 *
 * The 2px frame itself is a CSS `outline` (see ./styles.ts), which paints *outside* the
 * border box — so the width and height passed here are the target's own, with nothing
 * subtracted.
 */
export function outlineStyle(box: Box): OutlineStyle {
  return {
    transform: `translate3d(${round(box.x)}px, ${round(box.y)}px, 0)`,
    width: `${round(box.width)}px`,
    height: `${round(box.height)}px`,
  }
}

export interface Outline {
  readonly element: HTMLElement
  readonly visible: boolean
  /** Draw the frame around `box`, or hide it if there is nothing paintable there. */
  show(box: Box): void
  hide(): void
}

/**
 * Build an outline element. It is appended to the shadow root once and reused — the
 * mount/unmount cycle happens at the host level, not here.
 */
export function createOutline(modifier?: string): Outline {
  const element = document.createElement('div')
  element.className = modifier === undefined ? 'outline' : `outline outline--${modifier}`
  element.hidden = true

  return {
    element,

    get visible() {
      return !element.hidden
    },

    show(box) {
      if (!isPaintable(box)) {
        element.hidden = true
        return
      }

      const style = outlineStyle(box)
      element.style.transform = style.transform
      element.style.width = style.width
      element.style.height = style.height
      element.hidden = false
    },

    hide() {
      element.hidden = true
    },
  }
}

function round(value: number): number {
  const factor = 10 ** PRECISION
  return Math.round(value * factor) / factor
}
