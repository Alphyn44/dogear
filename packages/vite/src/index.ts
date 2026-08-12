import type { Plugin } from 'vite'

import type { ClientConfig, Modifier } from './client.js'
import {
  buildClientConfig,
  clientScriptSrc,
  MODIFIERS,
  resolveCoreDist,
} from './client.js'
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
  /**
   * Which key arms the overlay. Default `'alt'`.
   *
   * Same precedence as {@link DogearOptions.endpoint}: E4 (#29) layers `.dogear/config.json`
   * underneath this, and neither reaches past it.
   *
   * `'meta'` is the Windows key on Windows, where the OS claims it on keyup — it works, but
   * it is a poor choice there.
   */
  readonly modifier?: Modifier
}

/** What `configureServer` learned, and `transformIndexHtml` needs. */
interface Injection {
  readonly endpoint: string
  readonly config: ClientConfig
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
  /**
   * Set by `configureServer`, read by `transformIndexHtml`. `undefined` means "do not
   * inject" — either the hooks have not run, or dogear disabled itself.
   *
   * Safe as closure state on two counts. Vite awaits every `configureServer` hook before it
   * installs the middlewares that serve HTML, so there is no ordering in which
   * `transformIndexHtml` runs first. And `dogear()` returns a fresh object per call (pinned
   * by a test in ./index.test.ts), so two Vite roots in one process get two closures.
   */
  let injection: Injection | undefined

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
      // The *normalised* endpoint, not `options.endpoint` — core POSTs to
      // `<endpoint>/annotations`, and it has to be the path the middleware below is
      // actually mounted at. B5 (#12).
      const config = buildClientConfig({
        modifier: validateModifier(options.modifier),
        endpoint,
      })

      // Resolved once: the repository root cannot move while this process lives. The
      // brief's "never cache" rule is about queue *contents*, which are re-read on every
      // single write — see queue.ts. Conflating the two would mean walking the filesystem
      // on every request to learn something that cannot have changed.
      const gitRoot = findGitRoot(server.config.root)

      if (gitRoot === undefined) {
        // Warn and stay inert rather than throw. The queue location is undefined outside a
        // repository, but taking down someone's dev server over a dev tool is the wrong
        // trade — they came here to work on their app.
        //
        // `injection` is left undefined, so nothing is injected either. Coupling the two is
        // deliberate: an overlay that can point at elements but can never submit them is
        // half a tool, and the failure would surface as a MIME error from a client.js that
        // Vite's SPA fallback answered with index.html — which reads like a dogear bug
        // rather than "you are not in a git repository".
        server.config.logger.warn(
          `[dogear] no .git found above ${server.config.root}. dogear is disabled: the ` +
            'queue resolves from the git root, and there is no repository to resolve it ' +
            'from.',
        )
        return
      }

      const clientDist = resolveCoreDist()
      if (clientDist === undefined) {
        // Not fatal — the route answers with a stub module that says the same thing in the
        // browser console. Said here too, because the terminal is where someone who just
        // cloned the repo is actually looking.
        server.config.logger.warn(
          '[dogear] @dogear/core has not been built, so the overlay will not load. Run ' +
            '`npm run build -w @dogear/core`.',
        )
      }

      server.middlewares.use(createEndpoint({ gitRoot, endpoint, clientDist }))

      // Assigned last, after the endpoint that may throw and after the middleware is
      // registered — so there is no window in which the tag is injected but the route that
      // serves its import is not.
      injection = { endpoint, config }
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
      handler: () =>
        injection === undefined
          ? []
          : [
              {
                tag: 'script',
                attrs: {
                  type: 'module',
                  'data-dogear': SENTINEL,
                  // `src`, with no inline body at all — F4 (#34). A strict
                  // `script-src 'self'` blocks inline execution, and dogear failed silently
                  // with a console error that read like the host app's own bug. An external
                  // same-origin script needs no nonce, so dogear stays out of the host's CSP.
                  src: clientScriptSrc(injection.endpoint, injection.config),
                },
                injectTo: 'head-prepend',
              },
            ],
    },
  }
}

/**
 * Reject a bad `modifier` loudly, at config time.
 *
 * The mirror image of core's `resolveOptions`, which falls back to the default instead.
 * Same value, two audiences: here it is a developer reading a terminal while their dev
 * server starts, where a typo should be named; there it is a page load in a browser, where a
 * dev tool throwing has broken the app it exists to help inspect.
 *
 * Validated in `configureServer` rather than in the factory, for the same reason
 * `normaliseEndpoint` is: a misconfigured dev tool must not be able to take down a
 * production build. `apply: 'serve'` already excludes the plugin from one, and throwing from
 * the factory would run before that had a chance to matter.
 */
function validateModifier(modifier: Modifier | undefined): Modifier | undefined {
  if (modifier === undefined || MODIFIERS.includes(modifier)) return modifier

  throw new Error(
    `dogear: modifier must be one of ${MODIFIERS.join(', ')}, received ` +
      JSON.stringify(modifier),
  )
}

export default dogear
