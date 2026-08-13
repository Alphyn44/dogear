/**
 * C3 (#17) — the CSS selector half of the floor. Layer 2 of the brief's source-resolution
 * ladder, and the layer that has no dependencies at all.
 *
 * Layer 1 only exists where the transform ran. This one always works: third-party
 * components, portals, `.js` files, a non-Vite bundler, a transform that was switched off
 * — none of them change what a DOM element looks like from the outside. The brief's claim
 * for this layer is that "a distinctive class or a string of visible text is frequently
 * enough for the agent to find the component on its own", which is why the overlay shipped
 * a whole milestone before any source resolution existed.
 *
 * **dogear's own attributes are deliberately invisible here.** Nothing in this file may
 * anchor on `data-dogear-src` or `data-dogear-component`: a selector carrying them would
 * stop working the instant the transform is off, which is exactly the situation this layer
 * exists to survive. Only `id`, the test-id family, classes, tag names and `:nth-of-type`
 * are used, and all five are properties of the app rather than of dogear.
 *
 * **`:nth-of-type`, not `:nth-child`.** It counts among same-tag siblings only, so a
 * heading appearing above a list or a conditional paragraph rendering does not shift it —
 * and a dev app does that constantly between leaving a comment and an agent reading it.
 * The brief uses both forms in different places; its annotation *data contract* (the
 * normative one) uses `nth-of-type`, and the `nth-child` in the formatter illustration is
 * an inconsistency recorded on the issue rather than a second rule.
 */

/**
 * The attributes that count as a test id, in precedence order — first match wins.
 *
 * `data-testid` is React Testing Library's convention and dominates; the rest cover
 * Cypress and Playwright house styles for the price of four array entries. A test id is
 * the most *intentionally* stable hook on a page — someone chose it and something else
 * depends on it — which is why it outranks everything below an `id` here.
 *
 * Not configurable, on purpose. `.dogear/config.json` is E4's (#29) to introduce, and
 * ./host.ts is the pattern to copy when it lands: ship the defaults and the matcher now,
 * let E4 pass a second argument later.
 */
export const TEST_ID_ATTRIBUTES: readonly string[] = Object.freeze([
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
])

/**
 * How many ancestors the walk will climb before giving up on uniqueness.
 *
 * A bound rather than a target. The walk normally stops far earlier — the moment the
 * selector resolves uniquely — and this only governs the pathological page where it never
 * does. Eight is deep enough to escape any realistic component subtree and shallow enough
 * that the result is still something a human can read.
 */
export const MAX_DEPTH = 8

/** A class or id safe to write unescaped into a selector. */
const PLAIN_IDENTIFIER = /^-?[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * A trailing alphanumeric run of five or more mixing letters *and* digits — the shape
 * every CSS-modules and styled-components hash converges on.
 *
 * `Button_tab__x7f3q` is rejected on `x7f3q`; `btn-primary` survives because `primary` has
 * no digit; `bg-blue-500` survives because `500` has no letter. It is a heuristic and will
 * be wrong occasionally in both directions — the cost of a false reject is a slightly
 * longer selector, and the cost of a false accept is a selector that breaks on the next
 * build, so it is tuned to reject.
 */
const HASHED_SUFFIX =
  /(?:^|[_-])(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{5,}$/

/** The root a selector is resolved against — the document, or the shadow root it lives in. */
type SelectorRoot = Pick<Document, 'querySelector' | 'querySelectorAll'>

/**
 * The element's test id, or `undefined` where it has none.
 *
 * Undefined rather than null, and the caller omits the key entirely — the brief's `testId`
 * is optional, and an absent test id is a fact about the app rather than a failure to read
 * one. Same treatment `SourceSite.component` got in C2.
 */
export function testIdOf(element: Element): string | undefined {
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = element.getAttribute(attribute)
    if (value !== null && value !== '') return value
  }

  return undefined
}

/**
 * The shortest selector that uniquely identifies `element`.
 *
 * Two fast paths, then a walk. An `id` or a test id is both the shortest possible answer
 * and the most durable one, so they are tried first and returned outright when they verify.
 * Otherwise the walk prepends one ancestor segment at a time and checks after each, which
 * is what keeps the common case to two segments instead of a full path from `<body>`.
 *
 * **Never throws and never returns an empty string.** C3's criterion is that every
 * annotation carries a selector "regardless of framework, bundler, or resolution success",
 * so a page this cannot uniquely describe still gets the best path built — a selector
 * matching three elements is a usable hint, and the brief's `element` contract has no field
 * in which to report non-uniqueness. Inventing one would be this ticket writing D5's job.
 */
export function buildSelector(element: Element): string {
  const root = rootFor(element)

  const byId = ownIdSelector(element)
  if (byId !== null && resolvesTo(root, byId, element)) return byId

  const testId = testIdOf(element)
  if (testId !== undefined) {
    const byTestId = attributeSelector(testIdAttributeOf(element), testId)
    if (resolvesTo(root, byTestId, element)) return byTestId
  }

  const segments: string[] = []

  for (
    let current: Element | null = element, depth = 0;
    current !== null && depth < MAX_DEPTH;
    current = current.parentElement, depth += 1
  ) {
    // An ancestor's id ends the walk whether or not it disambiguates on its own: it is the
    // strongest anchor on the page, and anything above it can only make the selector longer
    // without making it more stable.
    const anchor = depth === 0 ? null : ownIdSelector(current)
    if (anchor !== null) {
      segments.unshift(anchor)
      break
    }

    segments.unshift(segmentFor(current))

    const candidate = segments.join(' > ')
    if (resolvesTo(root, candidate, element)) return candidate
  }

  // Not unique within the bound. Still the most specific description available, and still
  // more use to an agent than nothing — see the note on never failing, above.
  return segments.join(' > ')
}

/**
 * One path segment: the tag, narrowed by a usable class where one helps, else by position.
 *
 * The class is tried first because it is the half an agent can actually recognise —
 * `nav.tab-bar` names the thing, `nav:nth-of-type(1)` only counts it. A bare tag comes next,
 * for the common case of an element that is already the only one of its kind among its
 * siblings: `div:nth-of-type(1)` is noise, and this is a string a human reads. Position is
 * the fallback that always works.
 */
function segmentFor(element: Element): string {
  const tag = element.tagName.toLowerCase()

  const distinguishing = usableClasses(element).find((name) =>
    isUniqueAmongSiblings(element, `${tag}.${name}`),
  )
  if (distinguishing !== undefined) return `${tag}.${distinguishing}`

  if (isUniqueAmongSiblings(element, tag)) return tag

  const position = typeIndexOf(element)
  return position === null ? tag : `${tag}:nth-of-type(${String(position)})`
}

/**
 * The classes that may appear in a selector, in DOM order.
 *
 * Two filters, both about durability rather than tidiness. A class that is not already a
 * plain CSS identifier would need escaping — and every class that needs escaping in a real
 * app is a Tailwind utility (`w-1/2`, `hover:bg-x`, `md:flex`), which describes how the
 * element *looks* rather than what it *is*. Skipping them is why this file needs no
 * `CSS.escape`, whose availability across our test environments is not worth depending on.
 *
 * The second filter drops build-generated hashes; see {@link HASHED_SUFFIX}.
 */
function usableClasses(element: Element): string[] {
  return [...element.classList].filter(
    (name) => PLAIN_IDENTIFIER.test(name) && !HASHED_SUFFIX.test(name),
  )
}

/** Whether `selector` picks out exactly one element among the parent's children. */
function isUniqueAmongSiblings(element: Element, selector: string): boolean {
  const parent = element.parentElement
  if (parent === null) return true

  let matches = 0
  for (const sibling of parent.children) {
    if (sibling.matches(selector)) matches += 1
    if (matches > 1) return false
  }

  return matches === 1
}

/** 1-based position among same-tag siblings, or `null` when there is no parent to count in. */
function typeIndexOf(element: Element): number | null {
  const parent = element.parentElement
  if (parent === null) return null

  let index = 0
  for (const sibling of parent.children) {
    if (sibling.tagName === element.tagName) index += 1
    if (sibling === element) return index
  }

  return null
}

/**
 * `#main`, or `[id="…"]` for an id a selector could not carry literally, or `null`.
 *
 * The bracket form rather than `CSS.escape` for the reason given above — and it is also
 * the more honest output, since `#2fa\\-panel` is not something a reader can paste
 * anywhere useful.
 */
function ownIdSelector(element: Element): string | null {
  const id = element.id
  if (id === '') return null

  return PLAIN_IDENTIFIER.test(id) ? `#${id}` : attributeSelector('id', id)
}

/** Which of {@link TEST_ID_ATTRIBUTES} this element actually carries. */
function testIdAttributeOf(element: Element): string {
  return (
    TEST_ID_ATTRIBUTES.find((attribute) => {
      const value = element.getAttribute(attribute)
      return value !== null && value !== ''
    }) ?? TEST_ID_ATTRIBUTES[0]!
  )
}

/** `[data-testid="save-btn"]`, with the only two characters that can break the quoting escaped. */
function attributeSelector(attribute: string, value: string): string {
  return `[${attribute}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

/**
 * Whether `selector` resolves, within `root`, to `element` and to nothing else.
 *
 * **Both halves are load-bearing, and each catches what the other misses.** Uniqueness
 * alone would accept a selector that matches exactly one element and it is the *wrong* one
 * — worse than no selector, since an agent has no way to tell. Identity alone would accept
 * a selector that matches several while our target merely happens to come first in document
 * order: `button:nth-of-type(1)` finds the right button on a page whose only buttons are in
 * one nav, and finds a sidebar's button the day a sidebar is added above it. That is exactly
 * the churn `:nth-of-type` was chosen to resist, so settling for first-match here would give
 * it away one line lower down. Requiring both costs a segment or two on a busy page and buys
 * a selector that cannot be quietly reassigned by an unrelated part of the DOM.
 *
 * One `querySelectorAll` rather than a count plus a `querySelector`: the list already holds
 * the answer to both questions, and two queries could in principle disagree.
 *
 * A malformed selector makes the query throw rather than return empty — nothing here should
 * produce one, but "the floor always works" is the ticket, so a bug in a segment builder
 * must degrade into a longer selector rather than an exception on every click.
 */
function resolvesTo(root: SelectorRoot, selector: string, element: Element): boolean {
  try {
    const matches = root.querySelectorAll(selector)
    return matches.length === 1 && matches[0] === element
  } catch {
    return false
  }
}

/**
 * The document, or the shadow root the element lives in.
 *
 * A document-rooted `querySelector` can never see inside a shadow root, so verifying
 * against `document` would reject every correct answer for a shadow-contained element and
 * push it all the way to the depth cap. `getRootNode()` gives whichever root the element is
 * actually in; both `Document` and `ShadowRoot` expose the two methods needed.
 *
 * The fallback covers a detached element, whose root is a bare `DocumentFragment` in some
 * environments — it has the methods, but narrowing to them by feature rather than by
 * constructor avoids depending on `ShadowRoot` being a global.
 */
function rootFor(element: Element): SelectorRoot {
  const root = element.getRootNode() as Partial<SelectorRoot>

  return typeof root.querySelector === 'function' &&
    typeof root.querySelectorAll === 'function'
    ? (root as SelectorRoot)
    : document
}
