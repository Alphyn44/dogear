/**
 * C2 (#16) — the ancestor chain. Layer 1 of the brief's source-resolution ladder, read
 * from the browser side.
 *
 * `@dogear/vite`'s transform stamps every host JSX element with its source location; this
 * is the half that reads them back. Walking *up* from the clicked element rather than
 * taking only its own stamp is the whole ticket: the `<button>` you pointed at was written
 * in Button.tsx, but the decision to put it in a row was made in TabBar.tsx, and which one
 * you meant depends on the comment you have not typed yet. So dogear sends the chain and
 * lets the agent choose — see the brief's Decisions log, "Payload location → ancestor
 * chain, not a single site".
 *
 * **The chain crosses component boundaries by walking the DOM, not by understanding React.**
 * `<Button/>` itself is never stamped — the transform only touches host elements — so the
 * TabBar entry is the `<nav>` that wraps the button, not the `<Button label="Save"/>` line
 * that rendered it. That is the intended shape rather than a shortfall: the brief's own
 * example payload gives its TabBar site `"tag": "div"`. The agent gets the right file and a
 * line inside the right JSX block, which is what it needs to act. Recovering the literal
 * call site is what layer 3's fiber walk would buy, and layer 3 is deferred — there are no
 * framework internals anywhere in this file, and that is a property worth keeping.
 */

/**
 * The stamped attributes, duplicated from `@dogear/vite`'s ./stamp.ts rather than imported.
 *
 * Core is framework-agnostic and knows nothing about Vite — the same constraint that makes
 * ./submit.ts carry its own `PROTOCOL_VERSION`. The two halves cannot import each other, so
 * the copy is structural rather than lazy.
 *
 * Unlike that one, a drift here fails **open and silent**: core would query an attribute
 * nobody stamps, every annotation would carry `sites: []`, and no other test in the repo
 * would notice. ./parity.test.ts is the guard, mirroring `packages/cli/src/parity.test.ts`.
 */
export const SOURCE_ATTRIBUTE = 'data-dogear-src'

/** C5's (#19) display name. Absent wherever the source wrote no component name. */
export const COMPONENT_ATTRIBUTE = 'data-dogear-component'

/**
 * The brief's cap on `sites`, applied **after** deduplication.
 *
 * Order matters more than the number does. A chain of raw ancestors is mostly layout
 * wrappers from one file — a `<button>` inside two `<div>`s inside a `<section>`, all
 * written in Button.tsx — so capping first would spend the whole budget before the walk
 * ever reached the component that placed the element, which is precisely the location the
 * ticket exists to deliver. Deduplicating first makes the cap mean "five distinct places".
 */
export const MAX_SITES = 5

/**
 * One resolved source location.
 *
 * The field names are not ours to choose: `packages/cli/src/format.ts` already renders this
 * shape — `src/components/Button.tsx:12  (Button, via attribute)` — for the hook, and D1's
 * MCP server and D4's clipboard export share that formatter. It is the wire contract from
 * the brief's Annotation block.
 */
export interface SourceSite {
  /** Relative to the git root, forward slashes on every platform. The transform's doing. */
  readonly file: string
  /** 1-based, pointing at the `<` of the opening element in the original source. */
  readonly line: number
  /** 1-based. */
  readonly column: number
  /** Lowercase tag of the element the stamp was read from — `'button'`, never `'BUTTON'`. */
  readonly tag: string
  /**
   * **Omitted, not null,** where the source wrote no name. C5's "where available" is a fact
   * about the code — an anonymous default export or an element outside any component
   * boundary legitimately has none — and `format.ts` renders the trailing `(Button)` only
   * when the key is there.
   */
  readonly component?: string
  /**
   * How much to trust this location.
   *
   * A narrow literal rather than the brief's `'attribute' | 'runtime'` union. Layer 3 — the
   * runtime fiber walk that would emit `'runtime'` — is explicitly deferred and possibly
   * never built, and a variant nothing can produce invites a reader to write a branch for
   * it. Widening a union is not a breaking change; the day layer 3 lands, this grows.
   */
  readonly via: 'attribute'
}

/**
 * Walk from `from` to the document root, collecting stamped ancestors nearest-first.
 *
 * Starts at `from` itself — `closest()` semantics, as the brief specifies — so the element
 * you clicked contributes its own location before any of its parents do.
 *
 * Returns `[]` rather than throwing when nothing resolves, which is an ordinary outcome and
 * not an error: a third-party component, a portal, a `.js` file, or a project with the
 * transform off all produce it. C3's (#17) floor is what keeps such an annotation useful.
 */
export function collectSites(from: Element): readonly SourceSite[] {
  const sites: SourceSite[] = []
  const seen = new Set<string>()

  for (let current = from; ;) {
    const site = siteOf(current)

    // Deduplicated by file, nearest occurrence winning, because the walk sees the innermost
    // element first. Two components sharing one file collapse to one entry; that is the
    // accepted cost of making the cap count distinct places, and the surviving line is the
    // most specific one either way.
    if (site !== null && !seen.has(site.file)) {
      seen.add(site.file)
      sites.push(site)
      if (sites.length === MAX_SITES) break
    }

    const next = parentOf(current)
    if (next === null) break
    current = next
  }

  return sites
}

/**
 * The next element up, hopping out of a shadow root when there is one.
 *
 * `parentElement` is null at a shadow boundary as well as at `<html>`, and the two mean
 * different things. Stopping at the boundary would truncate the chain of a stamped app that
 * mounts a web component partway down — silently, since a short chain and an exhausted one
 * look identical from the outside.
 *
 * `getRootNode()` is checked by constructor rather than by duck-typing `.host`, and guarded
 * for the environments where `ShadowRoot` is not a global at all: core's non-DOM tests run
 * in the node environment, and a bare `instanceof` against an undeclared global throws.
 */
function parentOf(element: Element): Element | null {
  const parent = element.parentElement
  if (parent !== null) return parent

  if (typeof ShadowRoot === 'undefined') return null

  const root = element.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

/** The site an element carries, or `null` if it has no stamp or an unreadable one. */
function siteOf(element: Element): SourceSite | null {
  const raw = element.getAttribute(SOURCE_ATTRIBUTE)
  if (raw === null) return null

  const position = parseLocation(raw)
  if (position === null) return null

  const component = element.getAttribute(COMPONENT_ATTRIBUTE)

  return {
    ...position,
    tag: element.tagName.toLowerCase(),
    // Spread rather than `component: component ?? undefined`, so the key is genuinely
    // absent from the JSON rather than present-and-undefined. `JSON.stringify` drops both,
    // but `'component' in site` is the difference, and the empty check catches a stamp of
    // `data-dogear-component=""` that no transform emits and a hand-edit might.
    ...(component === null || component === '' ? {} : { component }),
    via: 'attribute',
  }
}

/**
 * `src/components/Button.tsx:12:5` → `{ file, line, column }`, or `null`.
 *
 * **Split from the right**, on the last two colons only. A colon is legal in a POSIX path,
 * and splitting from the left would turn `src/a:b/Button.tsx:12:5` into a file called
 * `src/a` with a line of `b`. Windows drive letters cannot appear — the transform's
 * `repoRelative` makes the path git-root-relative before stamping it.
 *
 * A malformed value is dropped **silently**, and the ancestor with it. dogear cannot tell a
 * hand-edited attribute from a stamp written by a version of the plugin it does not know,
 * and this runs on every click of a dev tool: a console warning per click is noise, and the
 * chain simply carries one fewer entry. Same posture as `stampSource`'s silent parse-error
 * path and ./host.ts's silent bail.
 */
function parseLocation(
  raw: string,
): { file: string; line: number; column: number } | null {
  const lastColon = raw.lastIndexOf(':')
  if (lastColon === -1) return null

  const firstColon = raw.lastIndexOf(':', lastColon - 1)
  if (firstColon === -1) return null

  const file = raw.slice(0, firstColon)
  if (file === '') return null

  const line = parsePosition(raw.slice(firstColon + 1, lastColon))
  const column = parsePosition(raw.slice(lastColon + 1))
  if (line === null || column === null) return null

  return { file, line, column }
}

/**
 * A 1-based position, or `null`.
 *
 * `Number` rather than `parseInt`, deliberately: `parseInt('12abc')` is 12, and a stamp that
 * is only partly a number is a stamp we do not understand. The whole string has to be one.
 */
function parsePosition(raw: string): number | null {
  if (raw === '') return null

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return null

  return value
}
