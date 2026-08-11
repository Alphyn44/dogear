import type { Plugin } from 'vite'

import { CLIENT_SOURCE } from './client.js'
import { createEndpoint, DEFAULT_ENDPOINT, normaliseEndpoint } from './endpoint.js'
import { findGitRoot } from './git-root.js'
import { SENTINEL } from './sentinel.js'

export interface DogearOptions {
  /**
   * Base path for dogear's HTTP endpoints. Default `/__dogear`, matching Vite's own
   * `/__vite_ping` convention.
   *
   * Reading this from `.dogear/config.json` is E4's job; the brief's model is that plugin
   * options override the file, so this is the layer that wins either way.
   */
  readonly endpoint?: string
}

/**
 * dogear's Vite plugin.
 *
 * It injects the dev script (A1) and serves the annotations endpoint (A2). The JSX
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
export function dogear(options: DogearOptions = {}): Plugin {
  return {
    name: 'dogear',
    apply: 'serve',
    enforce: 'pre',

    /**
     * The browser→disk half of the pipe (A2).
     *
     * Registered in the hook body rather than from a returned function, and that is the
     * load-bearing detail. Vite installs its own middlewares after `configureServer` runs,
     * so a middleware added here sees requests first; one added from the returned function
     * runs after them, by which point the SPA fallback has already answered
     * `/__dogear/annotations` with `index.html` and a 200.
     *
     * The endpoint is validated here rather than in the factory above so that a bad
     * `endpoint` option cannot throw during `vite build`. The plugin is excluded from
     * builds by `apply: 'serve'`, and a dev-tool misconfiguration taking down a production
     * build would invert the entire point of that line.
     */
    configureServer(server) {
      const endpoint = normaliseEndpoint(options.endpoint ?? DEFAULT_ENDPOINT)

      // Resolved once: the repository root cannot move while this process lives. The
      // brief's "never cache" rule is about queue *contents*, which are re-read on every
      // single write — see queue.ts. Conflating the two would mean walking the filesystem
      // on every request to learn something that cannot have changed.
      const gitRoot = findGitRoot(server.config.root)

      if (gitRoot === undefined) {
        // Warn and stay inert rather than throw. The queue location is undefined outside a
        // repository, but taking down someone's dev server over a dev tool is the wrong
        // trade — they came here to work on their app.
        server.config.logger.warn(
          `[dogear] no .git found above ${server.config.root}. The annotations endpoint ` +
            'is disabled: the queue resolves from the git root, and there is no repository ' +
            'to resolve it from.',
        )
        return
      }

      server.middlewares.use(createEndpoint({ gitRoot, endpoint }))
    },

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
