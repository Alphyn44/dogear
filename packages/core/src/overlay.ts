/**
 * B7 (#14) — the overlay's DOM island.
 *
 * Two guarantees, and both are narrower than B7's original wording, which claimed the
 * overlay "never appears in the user's own DOM queries or snapshot tests". That claim does
 * not survive contact with either scenario it covers. A component snapshot test never sees
 * dogear at all — the script reaches a page only through the dev server's
 * `transformIndexHtml`, and a jsdom component test loads no HTML document — so B7 contributes
 * nothing there; A1 already did it. And for a browser test driving the real dev server,
 * *any* node we render answers `document.querySelectorAll('*')`. Nothing rendered can be
 * invisible. The brief's AC is amended to what is actually true and actually useful:
 *
 * 1. **A closed shadow root.** `host.shadowRoot` is `null` to the app, so nothing it queries
 *    can reach inside, and no style crosses in either direction.
 * 2. **Zero nodes in the document while idle.** The host is inserted when something becomes
 *    visible and removed when nothing is. A test run that never holds the modifier sees a
 *    document byte-identical to the one dogear was never loaded into — which is the outcome
 *    the original AC was reaching for, and it holds regardless of what the test queries.
 *
 * The host is a `<dogear-overlay>` rather than a `<div>` for one reason: it is placed outside
 * `<body>`, which already hides it from `document.body` serialisation and from anything
 * scoped to an app container, and a hyphenated tag closes the last gap —
 * `document.querySelectorAll('div')` is a query a real app makes, and `dogear-overlay` is
 * not a name anything asks for. It is *not* a registered custom element: no upgrade, no
 * lifecycle callbacks, nothing in the registry to collide with. An unknown element is
 * `display: inline` by default, exactly like an unstyled div.
 */

import { HOST_STYLE, SHADOW_CSS } from './styles.js'

/** @see the class-name note in ./styles.ts — these are the shadow tree's own selectors. */
export const HOST_TAG = 'dogear-overlay'

export interface Overlay {
  /**
   * The shadow root, for the modules that render into it.
   *
   * Exposed here because the root is `closed` — `host.shadowRoot` returns `null`, so this
   * closure reference is the only handle that exists. That is also why every test of the
   * overlay's contents imports this module directly rather than going through `index.ts`.
   */
  readonly root: ShadowRoot
  /** The host element. Present in the document only while {@link Overlay.mounted}. */
  readonly host: Element
  readonly mounted: boolean
  /** Insert the host into the document. Idempotent. */
  mount(): void
  /** Remove the host from the document. Idempotent. */
  unmount(): void
  /** Unmount and drop the reference. The overlay is not reusable afterwards. */
  destroy(): void
}

/**
 * Build the host and its shadow root **without touching the document**.
 *
 * Nothing is appended here. `init()` runs on every page load of every dev server, and a
 * dogear that inserts a node merely by existing would break guarantee 2 before the user has
 * pressed anything.
 */
export function createOverlay(): Overlay {
  const host = document.createElement(HOST_TAG)
  host.setAttribute('style', HOST_STYLE)

  const root = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = SHADOW_CSS
  root.append(style)

  let destroyed = false

  return {
    root,
    host,

    get mounted() {
      return host.isConnected
    },

    mount() {
      if (destroyed || host.isConnected) return

      // `documentElement`, so the host is a sibling of `<body>` rather than inside it.
      // DOM insertion is not HTML parsing — the tree-construction rules that would relocate
      // a stray element during parse do not apply to `appendChild`, so it stays a child of
      // `<html>` and renders there. This one line is what keeps `document.body.innerHTML`
      // snapshots and anything scoped to an app container clean.
      //
      // If a browser is ever found to mishandle it, this is the single line to change to
      // `document.body` — at the cost of guarantee 2 needing amending again.
      document.documentElement.append(host)
    },

    unmount() {
      // `remove()` rather than emptying the shadow tree. A mounted-but-empty host is still
      // a node in the document, and a closed shadow root does not serialise into
      // `outerHTML` — so an "empty" host would look identical to a full one in exactly the
      // snapshot that is supposed to catch it.
      host.remove()
    },

    destroy() {
      destroyed = true
      host.remove()
    },
  }
}
