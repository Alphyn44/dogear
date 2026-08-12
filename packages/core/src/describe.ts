/**
 * What the comment box says it is pointing at.
 *
 * **Display only.** This is deliberately a *subset* of the brief's `element` payload
 * (`{ tag, selector, text, classes, id, testId }`) rather than a new shape, so C3 (#17)
 * widens it instead of replacing it.
 *
 * `selector` and `testId` are absent on purpose. C3's criterion — "every annotation carries
 * a CSS selector and a text snippet regardless of framework, bundler, or resolution success"
 * — makes the selector the floor of the entire localization ladder, and it has real design
 * content: which attributes may anchor a path, how deep to walk, and whether to verify
 * uniqueness with `querySelectorAll(...).length === 1`. Writing a throwaway version to fill
 * a tooltip means writing it twice, and the second author inherits a half-selector something
 * already depends on. A label needs none of it.
 */

/** First 80 characters of the element's text, per the brief's `element.text`. */
const TEXT_LIMIT = 80

/** Classes shown in a label before it gives up. A Tailwind element has forty. */
const LABEL_CLASS_LIMIT = 2

export interface ElementDescription {
  /** Lowercase tag name — `'button'`, never `'BUTTON'`. */
  readonly tag: string
  readonly id: string | null
  readonly classes: readonly string[]
  /** Trimmed, whitespace-collapsed, capped at 80 characters. */
  readonly text: string
}

export function describeElement(element: Element): ElementDescription {
  return {
    tag: element.tagName.toLowerCase(),
    // Empty string and absent are the same thing to a reader, and `id=""` is legal HTML.
    id: element.id === '' ? null : element.id,
    // `classList` rather than splitting `className`: it is already tokenised, and
    // `className` is an `SVGAnimatedString` on SVG elements, where `.split` does not exist.
    classes: [...element.classList],
    text: extractText(element),
  }
}

/** `button.tab — "Settings"`. */
export function labelFor(description: ElementDescription): string {
  const shownClasses = description.classes.slice(0, LABEL_CLASS_LIMIT)
  const overflow = description.classes.length > shownClasses.length ? '…' : ''

  const selectorish =
    description.tag +
    (description.id === null ? '' : `#${description.id}`) +
    shownClasses.map((name) => `.${name}`).join('') +
    overflow

  return description.text === '' ? selectorish : `${selectorish} — "${description.text}"`
}

/**
 * The brief specifies `innerText`, and the distinction from `textContent` is the point:
 * `innerText` is what the user can actually read, so it skips `display: none` subtrees and
 * respects line breaking. `textContent` is the fallback for the elements that have no
 * `innerText` — SVG, and anything that is not an `HTMLElement`.
 *
 * C3 owns whether the annotation payload's `text` is exactly this. Today it is a label, not
 * a contract.
 */
function extractText(element: Element): string {
  const raw = (element as Partial<HTMLElement>).innerText ?? element.textContent ?? ''

  // Collapsed before capping, so 80 characters means 80 readable ones rather than 80
  // characters of indentation from a prettily-formatted template.
  const collapsed = raw.replace(/\s+/g, ' ').trim()

  return collapsed.length > TEXT_LIMIT ? `${collapsed.slice(0, TEXT_LIMIT)}…` : collapsed
}
