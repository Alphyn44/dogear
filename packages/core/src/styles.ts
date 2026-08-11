/**
 * Every style the overlay uses, as two string constants.
 *
 * No `.css` file and no build-step import: @dogear/core is bundled by tsup with no CSS
 * loader configured, and adding one to ship roughly forty lines of CSS would buy nothing.
 * Prettier formats `.ts` but not the inside of a template literal, so what is written here
 * is what ships.
 */

/**
 * The host element's own styles, applied inline via `cssText`.
 *
 * **Inline, not a `:host` rule, and that distinction is load-bearing.** A `:host` rule lives
 * inside the shadow root and loses to the *outer* document's rules on the host element —
 * shadow encapsulation protects the tree's insides, not the host itself. An inline style
 * with `!important` outranks any author rule, which is what we need: `div { position:
 * static !important }` in someone's CSS reset is not a hypothetical.
 *
 * `all: initial` is the "no global styles leak **in**" half of B7 (#14). The shadow boundary
 * blocks *selectors* from crossing, but **inherited properties still cross it** — a
 * `body { font-family: Papyrus; line-height: 3 }` reaches the overlay's text through the
 * host. `all: initial` cuts inheritance at the boundary. It sets `display: inline`, which
 * the `position: fixed` below blockifies, so the order of these two declarations matters.
 *
 * The rest is why B2's (#9) "no layout shift, no scrollbars" holds: a fixed-position box is
 * out of flow, so nothing is displaced, and it is excluded from the viewport's scrollable
 * overflow region, so it cannot produce a scrollbar however it is sized. `inset: 0` makes it
 * exactly viewport-sized anyway.
 */
export const HOST_STYLE = [
  'all: initial !important',
  'position: fixed !important',
  'inset: 0 !important',
  'pointer-events: none !important',
  // The maximum 32-bit signed integer. A dev tool that a stacking context hides is a dev
  // tool that does not work; there is nothing legitimate to sit above it.
  'z-index: 2147483647 !important',
].join('; ')

/**
 * Styles for the shadow tree's own contents.
 *
 * Delivered as the `textContent` of a `<style>` element rather than through
 * `adoptedStyleSheets`. Constructable stylesheets exist to share one sheet across many roots
 * and there is exactly one root here, so the only thing they would buy is a feature-detect —
 * and their `ShadowRoot` support in happy-dom is uncertain, which would leave the overlay's
 * styling the one part of B7 the tests could not observe. A `<style>` element's content is
 * a string a test can compare.
 *
 * Nothing load-bearing lives in `:host` — see {@link HOST_STYLE}.
 */
export const SHADOW_CSS = `
* , *::before, *::after {
  box-sizing: border-box;
}

/*
 * Restated rather than inherited: "all: initial" on the host means the shadow tree starts
 * from the browser default, which is a serif face at whatever size the UA picks.
 */
.box {
  position: fixed;
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #f6f7f9;
  background: #1b1d23;
  border: 1px solid #3a3f4b;
  border-radius: 6px;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  padding: 8px;
  width: 280px;
  /* The one place pointer-events is turned back on. The host is "none" so the page keeps
     working underneath; the box has to be typable. */
  pointer-events: auto;
}

.label {
  font-size: 11px;
  color: #9aa3b2;
  margin-bottom: 6px;
  /* A long class list or text snippet must not stretch the box or wrap to five lines. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.input {
  display: block;
  width: 100%;
  font: inherit;
  color: inherit;
  background: #11131a;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  padding: 6px;
  resize: vertical;
}

.input:focus {
  outline: 2px solid #4c8dff;
  outline-offset: -1px;
}

/*
 * "outline" rather than "border": it paints outside the border box, so the frame surrounds
 * the target instead of overlapping it, and its width never has to be subtracted from the
 * measured rect. Outlines also never contribute to scrollable overflow — one of the four
 * reasons B2's no-scrollbars criterion holds.
 */
.outline {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  outline: 2px solid #4c8dff;
  background: rgb(76 141 255 / 0.08);
  border-radius: 2px;
}

.outline--captured {
  outline-color: #ffb020;
  background: rgb(255 176 32 / 0.10);
}

[hidden] {
  display: none !important;
}
`
