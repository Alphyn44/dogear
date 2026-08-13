/**
 * What the annotation says it is pointing at — the brief's `element` payload, in full since
 * C3 (#17).
 *
 * **This is the floor, and it is never empty.** `sites` can be `[]` — a third-party
 * component, a portal, a `.js` file, a bundler that is not Vite — but every annotation
 * carries this regardless, which is what C3's two criteria come down to. The selector and
 * the text snippet are two of the four independent anchors the brief's staleness decision
 * rests on, so an annotation whose line number has rotted is recoverable rather than lost.
 *
 * The same shape serves the comment box's label, via {@link labelFor}. One description, two
 * consumers: the alternative was a display subset alongside a wire payload, which is two
 * things to keep in agreement about what "the text" means.
 */

import { buildSelector, testIdOf } from './selector.js'

/** First 80 characters of the element's text, per the brief's `element.text`. */
const TEXT_LIMIT = 80

/** Classes shown in a label before it gives up. A Tailwind element has forty. */
const LABEL_CLASS_LIMIT = 2

export interface ElementDescription {
  /** Lowercase tag name — `'button'`, never `'BUTTON'`. */
  readonly tag: string
  /**
   * A CSS selector that resolves to this element. Never empty — see ./selector.ts, which
   * also explains why it is usually short and why it can, rarely, be non-unique.
   */
  readonly selector: string
  /**
   * Trimmed, whitespace-collapsed, capped at 80 characters — **and undecorated.**
   *
   * This is a contract rather than a label, which is the part that changed in C3. D5 marks
   * an item stale by looking for this string in the file the annotation names, so anything
   * appended to signal truncation — an ellipsis, say — guarantees the search fails for
   * every snippet long enough to need it. Truncation is a display concern and belongs to
   * {@link labelFor}; the CLI formatter likewise adds its own when it renders.
   */
  readonly text: string
  readonly classes: readonly string[]
  readonly id: string | null
  /**
   * The element's test id, where it has one — see `TEST_ID_ATTRIBUTES` in ./selector.ts.
   *
   * **Omitted, not null,** when absent. An app that does not use test ids is an ordinary
   * app rather than one dogear failed to read, and the agent-facing formatter renders the
   * field only when the key is there. Same treatment `SourceSite.component` got in C2.
   */
  readonly testId?: string
}

export function describeElement(element: Element): ElementDescription {
  const testId = testIdOf(element)

  // Field order follows the brief's `element` block rather than convenience. `queue.json`
  // is a file people read — "you can `cat` it when something breaks" is a stated design
  // goal — and the two anchors an agent reaches for first belong at the top.
  return {
    tag: element.tagName.toLowerCase(),
    selector: buildSelector(element),
    text: extractText(element),
    // `classList` rather than splitting `className`: it is already tokenised, and
    // `className` is an `SVGAnimatedString` on SVG elements, where `.split` does not exist.
    //
    // Every class, unfiltered. This is the raw signal; deciding which of them are stable
    // enough to anchor a path is ./selector.ts's job and nobody else's.
    classes: [...element.classList],
    // Empty string and absent are the same thing to a reader, and `id=""` is legal HTML.
    id: element.id === '' ? null : element.id,
    ...(testId === undefined ? {} : { testId }),
  }
}

/**
 * `button.tab — "Settings"`.
 *
 * **Where the truncation ellipsis lives now.** `description.text` is undecorated so D5 can
 * search for it; the affordance that says "there was more" is a display concern, so it is
 * applied here, at the only place a human reads it.
 *
 * Whether the text *was* truncated is inferred from its length, since the description does
 * not record it. Text that happens to be exactly 80 characters gains an ellipsis it did not
 * earn — a single character, in a label, in a dev tool. The alternative is a second field
 * carried through the wire payload to serve a tooltip.
 */
export function labelFor(description: ElementDescription): string {
  const shownClasses = description.classes.slice(0, LABEL_CLASS_LIMIT)
  const overflow = description.classes.length > shownClasses.length ? '…' : ''

  const selectorish =
    description.tag +
    (description.id === null ? '' : `#${description.id}`) +
    shownClasses.map((name) => `.${name}`).join('') +
    overflow

  if (description.text === '') return selectorish

  const text =
    description.text.length < TEXT_LIMIT ? description.text : `${description.text}…`

  return `${selectorish} — "${text}"`
}

/**
 * The brief specifies `innerText`, and the distinction from `textContent` is the point:
 * `innerText` is what the user can actually read, so it skips `display: none` subtrees and
 * respects line breaking. `textContent` is the fallback for the elements that have no
 * `innerText` — SVG, and anything that is not an `HTMLElement`.
 *
 * **Nothing is appended on truncation** — C3's call, and the reason is D5. It marks an item
 * stale when this snippet no longer appears in the file the annotation names, so a trailing
 * ellipsis would make every snippet past 80 characters permanently unfindable and every
 * long-text item permanently stale. The affordance moved to {@link labelFor}.
 */
function extractText(element: Element): string {
  const raw = (element as Partial<HTMLElement>).innerText ?? element.textContent ?? ''

  // Collapsed before capping, so 80 characters means 80 readable ones rather than 80
  // characters of indentation from a prettily-formatted template.
  const collapsed = raw.replace(/\s+/g, ' ').trim()

  return collapsed.slice(0, TEXT_LIMIT)
}
