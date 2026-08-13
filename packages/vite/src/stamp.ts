import { relative } from 'node:path'

import type { SourceMap } from 'magic-string'
import MagicString from 'magic-string'
import { normalizePath, parseSync } from 'vite'

/**
 * The JSX attribute transform — C1 (#15), and layer 1 of the brief's source-resolution
 * ladder.
 *
 * Every host element in an included file gets `data-dogear-src="file:line:col"`, so the
 * overlay can recover an exact source location with `closest()` — synchronously, with no
 * source maps, no promises, and no framework internals. The brief calls this "the layer
 * that won't rot", and the reason is that it is a pure function from source text to source
 * text: nothing here knows about React, and nothing here can be broken by a React release.
 *
 * **The parser is Vite's own.** Vite 8 is Rolldown-based and re-exports Oxc's `parseSync`,
 * which parses `.tsx` and `.jsx` (inferring the language from the filename) and *returns*
 * `{ program, errors }` rather than throwing. That removed the only real dependency this
 * ticket looked like it needed — an earlier plan reached for `@babel/parser`. `magic-string`
 * is still here, because a transform that returns code without a sourcemap makes Vite log
 * "Sourcemap is likely to be incorrect" against every file it touches.
 *
 * **Only host elements are stamped** — lowercase `JSXIdentifier` names. `<Button/>` gets
 * nothing: React would pass the attribute through as an unknown prop, and if the component
 * spread it onto its own root element the host element's own stamp would win anyway, since
 * ours is always inserted last. C2 (#16) builds its ancestor chain by walking the DOM, which
 * crosses component boundaries on its own.
 *
 * **Positions are 1-based on both axes** and anchor at the `<` of the opening element, so
 * the value reads the way an editor, a terminal file link, or a stack trace reads. Oxc
 * reports offsets as JS string indices rather than UTF-8 bytes, so no conversion is needed
 * for non-ASCII source.
 *
 * The value is exactly three colon-separated fields and stays that way: C5 (#19) puts the
 * component display name in a separate attribute rather than a fourth field here, because a
 * positional format with optional trailing parts is the shape that rots.
 */

/**
 * The stamped attribute.
 *
 * `scripts/check-leak.ts` carries this same literal as its `source-attribute` rule, which is
 * what actually enforces "absent from production builds" — F2 wrote that rule before this
 * transform existed. The duplication is deliberate for the same reason `sentinel.ts` states:
 * the leak scanner must not have to import from a package to know what to look for. Unlike
 * the sentinel there is no drift test, because a rename here that the scanner missed would
 * fail closed — the gate would simply stop finding anything, and `npm run verify` would still
 * pass. If that ever stops feeling safe, the fix is a test, not an import.
 */
export const SOURCE_ATTRIBUTE = 'data-dogear-src'

/**
 * The component display name — C5 (#19). Stamped only where the source actually wrote one.
 *
 * A second attribute rather than a fourth field inside {@link SOURCE_ATTRIBUTE}, because
 * "where available" is doing real work in C5: anonymous components and host elements
 * outside any component boundary legitimately have no name. A positional format with an
 * optional trailing part is the shape that rots.
 *
 * Named to match the wire contract — the brief's annotation carries `sites[].component`, and
 * the agent-facing formatter prints `(Button, via attribute)`. One word the whole way down.
 *
 * `scripts/check-leak.ts` needs its own literal rule for this, separate from the one
 * watching `data-dogear-src`. Widening that rule's needle to `data-dogear` would look
 * tempting and is wrong: the example app renders the text `<script data-dogear>` as prose
 * explaining A1, so the substring is legitimately present in a healthy production build.
 */
export const COMPONENT_ATTRIBUTE = 'data-dogear-component'

export interface StampResult {
  readonly code: string
  readonly map: SourceMap
}

/**
 * Stamp every host element in `code` with its source location.
 *
 * Returns `null` — meaning "leave this module byte-identical" — in every case where there is
 * nothing useful to do: the file is not inside the repository, it does not parse, it holds no
 * JSX, or every element in it was already stamped. Returning `null` rather than the unchanged
 * string matters, because it keeps dogear out of the module's transform chain entirely.
 *
 * **A parse error is silent.** `parseSync` reports errors rather than throwing, and we drop
 * them: dogear cannot distinguish "you are mid-keystroke" from "you put a `.js` in `include`",
 * and Vite reports the real syntax error a moment later with a proper code frame. A dogear
 * warning on every keystroke inside a broken file would be pure noise.
 *
 * @param id  The Vite module id. May carry a query (`/src/App.tsx?t=1739…`); it is stripped.
 * @param gitRoot  Paths in the attribute are relative to this — see the Decisions log.
 */
export function stampSource(
  code: string,
  id: string,
  gitRoot: string,
): StampResult | null {
  const file = stripQuery(id)

  const repoPath = repoRelative(file, gitRoot)
  if (repoPath === null) return null

  const parsed = parseSync(file, code)
  if (parsed.errors.length > 0) return null

  const found: FoundElement[] = []
  collectOpeningElements(parsed.program, null, found)
  if (found.length === 0) return null

  const starts = lineStarts(code)
  const magic = new MagicString(code)
  let stamped = 0

  for (const { element, component } of found) {
    if (!isHostElement(element.name)) continue
    if (isAlreadyStamped(element.attributes)) continue

    const insertAt = insertionPoint(element)
    if (insertAt === null) continue

    const { line, column } = positionAt(starts, element.start)

    // Both attributes in one string rather than two `appendLeft` calls at the same offset,
    // so the emitted order is stated here instead of resting on magic-string's same-index
    // semantics. The component half is simply absent when the source wrote no name — C5's
    // "where available", which is a fact about the code rather than a failure to resolve.
    //
    // A component name needs no escaping: it is a JS identifier, so it cannot contain a
    // quote. The path can in principle, which is why `repoRelative` guards that one.
    const name = component === null ? '' : ` ${COMPONENT_ATTRIBUTE}="${component}"`
    magic.appendLeft(
      insertAt,
      ` ${SOURCE_ATTRIBUTE}="${repoPath}:${line}:${column}"${name}`,
    )
    stamped += 1
  }

  if (stamped === 0) return null

  return {
    code: magic.toString(),
    map: magic.generateMap({ hires: true, source: file }),
  }
}

/**
 * Where the attribute goes: immediately after the last existing attribute, or after the tag
 * name when there are none.
 *
 * **Last is the load-bearing part** — the whole of acceptance criterion 4. JSX compiles
 * attributes into an object literal in source order, so `<div {...props} data-dogear-src="…"/>`
 * becomes `{ ...props, "data-dogear-src": "…" }` and a spread cannot clobber us. Inserting
 * before the attributes would invert that and let a `{...props}` carrying a parent's stale
 * value win.
 *
 * Anchoring to the last attribute rather than to the closing `>` is what keeps the output
 * tidy. Both positions satisfy the criterion, but `element.end - 2` on a spaced `<div />`
 * lands between the space and the slash and yields `<div  data-dogear-src="…"/>` — a double
 * space and a jammed slash, in text a developer reads in the Sources panel.
 *
 * The inserted text contains no newline, so every original line number downstream —
 * including the ones @vitejs/plugin-react is about to compile against — is unchanged.
 *
 * Returns `null` if neither anchor carries an offset, which no Oxc node shape produces; the
 * element is then skipped rather than stamped at a guessed position.
 */
function insertionPoint(element: JsxOpeningElement): number | null {
  return endOffset(element.attributes.at(-1)) ?? endOffset(element.name)
}

function endOffset(node: unknown): number | null {
  if (node === null || typeof node !== 'object') return null

  const end = (node as { end?: unknown }).end
  return typeof end === 'number' ? end : null
}

/**
 * The subset of an Oxc `JSXOpeningElement` this module reads.
 *
 * Declared structurally rather than imported from `@oxc-project/types`, which is a
 * transitive dependency we would otherwise have to declare in order to name four fields.
 */
interface JsxOpeningElement {
  readonly name: unknown
  readonly attributes: readonly unknown[]
  readonly start: number
}

/** An element and the component it was found inside, or `null` outside any. */
interface FoundElement {
  readonly element: JsxOpeningElement
  readonly component: string | null
}

interface Position {
  readonly line: number
  readonly column: number
}

/**
 * Vite module ids arrive with a query — `/src/App.tsx?t=1739…` on an HMR re-request, and
 * `?import` or `?worker` elsewhere. Oxc infers the language from the extension, so the
 * query has to come off before it ever sees the name.
 */
function stripQuery(id: string): string {
  const query = id.indexOf('?')
  return query === -1 ? id : id.slice(0, query)
}

/**
 * The path as the agent will read it: relative to the git root, forward slashes.
 *
 * Git-root-relative rather than Vite-root-relative because that is where everything on the
 * receiving end already resolves from — the queue lives at `<git-root>/.dogear/queue.json`,
 * and D1's MCP server finds its repo by walking up from `cwd` for `.git`. A Vite-root
 * relative path would also make three dev servers in one monorepo emit `src/App.tsx` for
 * three different files into a single queue.
 *
 * Returns `null` for anything outside the repository — a linked dependency, a file above the
 * root — because `../../elsewhere/Button.tsx` is not a path the agent can act on.
 */
function repoRelative(file: string, gitRoot: string): string | null {
  const path = normalizePath(relative(gitRoot, file))

  if (path === '' || path.startsWith('../')) return null
  // A double quote would close the attribute early and produce invalid JSX. Vanishingly
  // rare on any real filesystem, but silently emitting broken syntax into someone's app is
  // not a failure mode worth leaving open. Backslashes cannot appear — normalizePath is
  // what removes them on Windows.
  if (path.includes('"')) return null

  return path
}

/**
 * Depth-first over every own property, collecting opening elements and the component that
 * encloses each one.
 *
 * Generic rather than a typed visitor on purpose: it cannot miss a node type nobody
 * anticipated, and it descends into attribute expressions too, so `<div title={<Icon/>}>`
 * yields both elements. Oxc's AST is a plain acyclic object tree, so there is no parent
 * pointer to guard against.
 *
 * `component` is the enclosing name inherited from above, replaced on the way down whenever
 * a node introduces a capitalized binding of its own. Carrying it downward rather than
 * walking back up is what keeps this a single pass — and it is why an anonymous `.map`
 * callback or a lowercase helper is *transparent* rather than shadowing: neither one
 * produces a name, so children keep seeing the component that contains them.
 */
function collectOpeningElements(
  node: unknown,
  component: string | null,
  found: FoundElement[],
): void {
  if (Array.isArray(node)) {
    for (const child of node) collectOpeningElements(child, component, found)
    return
  }

  if (node === null || typeof node !== 'object') return

  if ((node as { type?: unknown }).type === 'JSXOpeningElement') {
    found.push({ element: node as unknown as JsxOpeningElement, component })
  }

  const inner = componentNameOf(node) ?? component
  for (const value of Object.values(node)) {
    collectOpeningElements(value, inner, found)
  }
}

/**
 * The component name a node introduces, if any — C5 (#19).
 *
 * Capitalized only, which is React's own rule for what is a component rather than a plain
 * function. That single filter is what makes the whole table work:
 *
 * - `const Button = memo(() => …)` keeps `Button`, because the declarator carries the name
 *   and the wrapper call is just another node on the way down.
 * - `class Panel { render() {…} }` keeps `Panel`, because `render` is lowercase.
 * - `items.map((item) => <li/>)` keeps whatever contains it, because the arrow is anonymous.
 * - `const row = () => <td/>` keeps the enclosing component rather than reporting `row`,
 *   which would name a helper as though it were the thing to open.
 *
 * `VariableDeclarator` is checked without looking at its initialiser for exactly the
 * `memo`/`forwardRef` case. The `Identifier` test also disposes of destructuring —
 * `const { A } = x` has an `ObjectPattern` id and yields nothing.
 */
function componentNameOf(node: object): string | null {
  const candidate = node as { type?: unknown; id?: unknown }

  switch (candidate.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'VariableDeclarator':
      break
    default:
      return null
  }

  const id = candidate.id as { type?: unknown; name?: unknown } | null | undefined
  if (id?.type !== 'Identifier' || typeof id.name !== 'string') return null

  return /^[A-Z]/.test(id.name) ? id.name : null
}

/**
 * Host elements are the lowercase ones — JSX's own rule for what becomes a DOM tag rather
 * than a component reference.
 *
 * `JSXMemberExpression` (`<Foo.Bar/>`) and `JSXNamespacedName` (`<svg:path/>`) both fail the
 * identifier check and are skipped. Fragments never reach here at all: `<>` parses as
 * `JSXOpeningFragment`, a different node type with no name.
 */
function isHostElement(name: unknown): boolean {
  if (name === null || typeof name !== 'object') return false

  const identifier = name as { type?: unknown; name?: unknown }
  if (identifier.type !== 'JSXIdentifier') return false
  if (typeof identifier.name !== 'string') return false

  return /^[a-z]/.test(identifier.name)
}

/**
 * Skip an element that already carries the attribute, which makes the transform idempotent
 * — running it twice cannot produce a duplicate prop. It also leaves a hand-written
 * `data-dogear-src` alone, on the grounds that someone who typed one meant it.
 */
function isAlreadyStamped(attributes: readonly unknown[]): boolean {
  return attributes.some((attribute) => {
    if (attribute === null || typeof attribute !== 'object') return false

    const node = attribute as { type?: unknown; name?: unknown }
    if (node.type !== 'JSXAttribute') return false

    const name = node.name as { type?: unknown; name?: unknown } | undefined
    // Dashed attribute names are a single JSXIdentifier in Oxc's AST — `data-dogear-src`
    // arrives whole, not as three tokens.
    return name?.type === 'JSXIdentifier' && name.name === SOURCE_ATTRIBUTE
  })
}

/** Offset of the first character of each line. Always starts with 0, so never empty. */
function lineStarts(code: string): number[] {
  const starts = [0]

  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 0x0a) starts.push(index + 1)
  }

  return starts
}

/**
 * Offset → 1-based line and column.
 *
 * Both axes count from 1 so the value reads the way editors, terminal file links and stack
 * traces read. Columns are UTF-16 code units, matching the offsets Oxc reports and the
 * indices `String.prototype.slice` uses.
 *
 * The `?? 0` fallbacks are unreachable — `low` and `mid` are always inside the array, which
 * always has at least one entry — and exist only because `noUncheckedIndexedAccess` cannot
 * see that.
 */
function positionAt(starts: readonly number[], offset: number): Position {
  let low = 0
  let high = starts.length - 1

  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((starts[mid] ?? 0) <= offset) low = mid
    else high = mid - 1
  }

  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 }
}
