/**
 * Every style the overlay uses, as two string constants.
 *
 * No `.css` file and no build-step import: dogear-core is bundled by tsup with no CSS
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
 * from the browser default, which is a serif face at whatever size the UA picks. Shared by
 * all three surfaces for the same reason — none inherits anything across the boundary.
 *
 * Note this also restyles two <button> elements. Shadow encapsulation blocks the *page's*
 * rules, not the user agent's, so a button inside the root still arrives with a system font,
 * a beveled border and a grey background unless something says otherwise.
 */
.box, .badge, .panel {
  position: fixed;
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #f6f7f9;
  background: #1b1d23;
  border: 1px solid #3a3f4b;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
}

.box {
  border-radius: 6px;
  padding: 8px;
  width: 280px;
  pointer-events: auto;
}

/*
 * B3's (#10) pending count, and the one thing dogear renders that outlives a gesture — see
 * ./badge.ts for what that costs B7 (#14).
 *
 * Bottom-right because apps put nav, logos and primary CTAs top-left and top-right far more
 * often, so it collides with the least; it is also furthest from where the comment box lands,
 * which anchors below its target by preference and so clusters upward.
 */
.badge {
  right: 12px;
  bottom: 12px;
  border-radius: 999px;
  padding: 5px 11px;
  font-size: 12px;
  cursor: pointer;
  /* B4 (#11): it opens the panel now, so it takes clicks. It was inert through B3 on the
     argument that a control which looks clickable and does nothing swallows app clicks in
     this corner — that objection is spent, not forgotten. */
  pointer-events: auto;
}

.badge:hover {
  background: #242730;
}

/*
 * B4's (#11) review panel. Rises from the badge, which is its handle.
 *
 * The 50px clears the badge: 12px of inset, plus its own box — 12px text at line-height
 * 1.45, 5px of padding each side, 1px of border — with a few pixels of gap. Stated here
 * rather than derived, because the alternative is wrapping both in a positioned container
 * and that trades one magic number for a whole extra element.
 *
 * Capped and scrolling rather than growing without limit: eight annotations is the workflow
 * this exists for, and a panel tall enough for eight is already covering half the app.
 */
.panel {
  right: 12px;
  bottom: 50px;
  width: 320px;
  max-height: min(60vh, 420px);
  border-radius: 8px;
  padding: 6px;
  overflow-y: auto;
  pointer-events: auto;
}

.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.item {
  border: 1px solid #3a3f4b;
  border-radius: 6px;
  padding: 6px;
  background: #15171d;
}

.item-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 5px;
}

.item-label {
  font-size: 11px;
  color: #9aa3b2;
  /* The label is the part that may be forty Tailwind classes long, so it is the part that
     gives way — the page and the × keep their width. */
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-page {
  font-size: 11px;
  color: #6b7280;
  flex: 0 0 auto;
}

.item-drop {
  flex: 0 0 auto;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  color: #9aa3b2;
  background: transparent;
  border: 0;
  border-radius: 4px;
  padding: 2px 5px;
  cursor: pointer;
}

.item-drop:hover {
  color: #f6f7f9;
  background: #3a3f4b;
}

/*
 * Always a live textarea, never a click-to-edit affordance — see ./panel.ts. It is styled to
 * read as text until you interact with it, so a list of five is a list rather than a form.
 */
.item-comment {
  display: block;
  width: 100%;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 3px 4px;
  resize: vertical;
}

.item-comment:hover {
  border-color: #3a3f4b;
}

.item-comment:focus {
  background: #11131a;
  outline: 2px solid #4c8dff;
  outline-offset: -1px;
}

/*
 * B5's (#12) footer: the batch note, a failure line, and Submit.
 *
 * It scrolls with the list rather than sticking to the bottom of the panel. Sticky was the
 * first instinct and it is wrong here: the panel is capped at eight-ish items before it
 * scrolls, and a pinned footer would cover the last row at exactly the moment you are
 * reading it to decide whether to send. The button being one flick away is enough.
 */
.footer {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid #3a3f4b;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Styled like a row's comment rather than like the box's input: it is optional, and a field
   that reads as prose invites a sentence where an empty form field invites skipping. */
.note {
  display: block;
  width: 100%;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid #3a3f4b;
  border-radius: 4px;
  padding: 3px 4px;
  resize: vertical;
}

.note::placeholder {
  color: #6b7280;
}

.status {
  font-size: 11px;
  /* Wrapping, not truncating: this is the only place a server's reason is readable, and an
     ellipsis on "batch[2].comment must be a non-empty string" hides the part that names
     what to fix. */
  overflow-wrap: anywhere;
}

.status-error {
  color: #ff9a9a;
}

/*
 * B6's (#13) toggle sits beside Submit rather than under it, pushed to opposite ends. The
 * destructive-ish action is furthest from the one you press every time, which is the whole
 * reason they share a row instead of stacking.
 */
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.submit {
  font: inherit;
  font-size: 12px;
  color: #f6f7f9;
  background: #2f6fd0;
  border: 1px solid #4c8dff;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
}

.submit:hover:not(:disabled) {
  background: #3a82ea;
}

.submit:disabled {
  color: #9aa3b2;
  background: #242730;
  border-color: #3a3f4b;
  cursor: default;
}

/*
 * Deliberately quiet — a bare link, not a button shape. It is a one-way door (nothing in the
 * page can undo it) and it is used approximately never, so it should not compete with Submit
 * for the eye. Underlined on hover rather than tinted, so it reads as an action and not as a
 * disabled control.
 */
.disable {
  font: inherit;
  font-size: 11px;
  color: #9aa3b2;
  background: transparent;
  border: 0;
  border-radius: 4px;
  padding: 4px 2px;
  cursor: pointer;
}

.disable:hover {
  color: #f6f7f9;
  text-decoration: underline;
}

/*
 * The panel's key hints — the counterpart to the comment box's .hint, and dimmer, because the
 * panel has visible controls for both of the things it names and the box has none.
 *
 * No backticks anywhere in this file: it is one template literal, and a stray one silently
 * ends the stylesheet rather than failing loudly.
 */
.footer-hint {
  font-size: 11px;
  color: #6b7280;
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

/*
 * The key bindings. Enter-versus-Shift+Enter is a coin-flip between two live conventions and
 * the box is modal with no other affordance, so there is nowhere else to learn it — and
 * someone who wants a second line otherwise finds out by losing their first.
 */
.hint {
  font-size: 11px;
  color: #9aa3b2;
  margin-top: 6px;
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

.input:focus,
.note:focus,
.badge:focus-visible,
.item-drop:focus-visible,
.submit:focus-visible,
.disable:focus-visible {
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
