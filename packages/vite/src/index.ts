import type { Plugin } from 'vite'

import { CLIENT_SOURCE } from './client.js'
import { SENTINEL } from './sentinel.js'

/**
 * dogear's Vite plugin.
 *
 * It injects the dev script (A1) and nothing else yet — the endpoint is A2 and the JSX
 * attribute transform is C1.
 *
 * **`apply: 'serve'`** is the primary production defense, not a convenience. The plugin
 * does not exist during `vite build` at all, which covers the script injection and the
 * attribute transform with one line. Every other layer in the brief's "Keeping it out of
 * production" is a backstop behind this one — including the sentinel below, which exists
 * so that `npm run check:leak` has something to catch if this line is ever wrong.
 *
 * **`enforce: 'pre'`** is load-bearing for C1. Vite runs `pre` plugins before the
 * React plugin compiles JSX, so the eventual transform sees real JSX syntax rather
 * than already-compiled `jsx()` calls. Establishing it now means the ordering is a
 * decision rather than an accident of whoever writes the transform.
 *
 * Note there is no production/noop `exports` split here, unlike @dogear/core. This
 * package is a devDependency that is only ever imported by a Vite config, so it has
 * no path into an application bundle to defend.
 */
export function dogear(): Plugin {
  return {
    name: 'dogear',
    apply: 'serve',
    enforce: 'pre',

    /**
     * Injecting the tag here rather than asking the user to add a `<script>` is the whole
     * point of A1: user source never references dogear, so there is no import for a
     * bundler to follow into production.
     *
     * `order: 'post'` is separate from the plugin's `enforce: 'pre'` — Vite buckets
     * `transformIndexHtml` hooks by the hook's own order. A `pre` hook runs before Vite's
     * core HTML handling, which would route this inline module script through the
     * html-proxy machinery and turn one verbatim tag into a tag plus a generated module.
     * Running post emits exactly what is written below. The payload has no imports, so it
     * needs none of that processing.
     *
     * `injectTo` is independent of hook order, so `head-prepend` still puts dogear first
     * in document order — ahead of the app's own module, which is where B1's overlay will
     * want to be.
     */
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'script',
          attrs: { type: 'module', 'data-dogear': SENTINEL },
          children: CLIENT_SOURCE,
          injectTo: 'head-prepend',
        },
      ],
    },
  }
}

export default dogear
