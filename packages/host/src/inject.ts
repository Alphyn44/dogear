import { SENTINEL } from './sentinel.js'

/**
 * Where dogear's `<script>` goes in a Next root layout, and what it says, for J4 (#80).
 *
 * Under Vite the tag is HTML, injected by `transformIndexHtml`. A Next App Router app has no
 * HTML file: the document is JSX in whichever layout renders `<html>`. J1 ruled that the
 * wrapper's loader adds the tag there, so this module answers two questions about a parsed
 * file, and ./stamp.ts applies the answer in the same pass as the stamps.
 *
 * **Every JSX `<html>`, not every file named `layout`.** Route groups give an app several root
 * layouts, `global-error` renders its own `<html>`, and a shared `<Shell>` component may be
 * the file that actually spells it. A page renders exactly one `<html>`, so one tag reaches it
 * however the layouts are arranged.
 *
 * **An `async` module script, as the first child of `<body>`.** React 19 treats
 * `<script async src>` as a resource: it hoists it into `<head>`, renders it once however many
 * layouts carry it, does not match it during hydration, and does not re-run it on a client
 * navigation. A plain `<script>` would be hydrated as an ordinary element, and a client
 * re-render of the layout earns React's warning that scripts rendered on the client never
 * execute. `async` gives up ordering against the app's own scripts, which Next loads `async`
 * anyway. `<body>` rather than `<html>` because React's nesting check allows only `<head>` and
 * `<body>` as children of `<html>`; `<html>` is the fallback for a layout that renders its
 * `<body>` elsewhere.
 *
 * **What it cannot see** is an `<html>` that is not JSX in the app's own source: rendered by a
 * dependency's component, or through `createElement`. That app gets no tag and no message. The
 * loader cannot know that a file it never saw was the root layout, and Next compiles routes
 * lazily, so there is no moment at which "no layout carried the tag" is true.
 */

/**
 * The tag's JSX, for one `src`.
 *
 * `src` is a JSX expression holding a JSON string rather than a quoted attribute, so no
 * character in the endpoint can close the attribute early. `clientScriptSrc` already
 * percent-encodes the config; the endpoint is a path `normaliseEndpoint` accepted, and JSON
 * escaping covers whatever that admits.
 *
 * The sentinel rides on `data-dogear`, as under Vite, so `check:leak` has the same two
 * carriers to find: this attribute in rendered HTML, and the bundle it loads.
 */
export function clientTag(src: string): string {
  return `<script async type="module" data-dogear="${SENTINEL}" src={${JSON.stringify(src)}} />`
}

/**
 * The offsets the tag is inserted at: just after the opening `<body …>` inside each JSX
 * `<html>`, or just after the opening `<html …>` when it has no `<body>` child of its own.
 *
 * An `<html>` written self-closing has no children to prepend to, and is skipped.
 */
export function tagSites(program: unknown): number[] {
  const sites: number[] = []
  collect(program, sites)
  return sites
}

/**
 * The subset of an Oxc `JSXElement` this module reads, declared structurally for the reason
 * ./stamp.ts gives.
 */
interface JsxElement {
  readonly type: 'JSXElement'
  readonly openingElement: { readonly name: unknown; readonly end: number }
  readonly closingElement: unknown
  readonly children: readonly unknown[]
}

function collect(node: unknown, sites: number[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, sites)
    return
  }

  if (node === null || typeof node !== 'object') return

  if (isElementNamed(node, 'html')) {
    const html = node as JsxElement
    if (html.closingElement !== null) {
      const body = html.children.find((child) => isElementNamed(child, 'body')) as
        JsxElement | undefined
      sites.push(
        body !== undefined && body.closingElement !== null
          ? body.openingElement.end
          : html.openingElement.end,
      )
    }
  }

  for (const value of Object.values(node)) collect(value, sites)
}

function isElementNamed(node: unknown, tag: string): boolean {
  if (node === null || typeof node !== 'object') return false
  if ((node as { type?: unknown }).type !== 'JSXElement') return false

  const name = (node as JsxElement).openingElement.name as
    { type?: unknown; name?: unknown } | undefined
  return name?.type === 'JSXIdentifier' && name.name === tag
}
