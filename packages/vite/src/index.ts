import type { FilterPattern, Plugin } from 'vite'
import { createFilter } from 'vite'

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
import { stampSource } from './stamp.js'

/**
 * Which files the JSX transform touches by default — C1 (#15), and the same pair the
 * brief's `.dogear/config.json` names.
 *
 * JSX-only by design. A `.js` holding JSX is not parsed as JSX by Oxc, and forcing it would
 * mean dogear deciding a file's language against the project's own toolchain. The brief
 * lists `.js` files among the places the attribute legitimately does not reach; they get
 * the selector floor (C3) instead.
 */
const DEFAULT_INCLUDE = ['**/*.jsx', '**/*.tsx']

/**
 * Never transform dependencies. Stamping them would point the agent at code inside
 * `node_modules` that it has no business editing, and a linked workspace dependency is
 * already covered by its own dev server.
 */
const DEFAULT_EXCLUDE = ['**/node_modules/**']

export interface DogearOptions {
  /**
   * Turn dogear off for this project entirely. Default `true` — B6 (#13).
   *
   * `false` means **nothing is injected and no endpoint is served**: not an inert overlay, no
   * script tag, no bundle sent to a page that asked for none. The same call the missing-git-
   * root branch below already makes.
   *
   * It also settles precedence without any code: B6's in-browser toggle lives in
   * `localStorage` and is per-origin, and it cannot contradict this, because a disabled plugin
   * never puts dogear in the browser to be toggled. A committed `enabled: false` is off for
   * everyone who clones the repo.
   *
   * Not a production-safety layer. `apply: 'serve'` is that, and this changes nothing about
   * what a build contains — see the brief.
   */
  readonly enabled?: boolean
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
  /**
   * Stamp `data-dogear-src` onto host JSX elements in dev. Default `true` — C1 (#15).
   *
   * `false` keeps the whole overlay: you still point, comment and submit, but annotations
   * carry no exact source location and fall back to the selector floor (C3), exactly as they
   * do in a Vue or Svelte app. That is the axis this option exists on — it is about source
   * *resolution*, not about whether dogear runs. {@link DogearOptions.enabled} is the latter.
   *
   * Same precedence as the options above: E4 (#29) layers `.dogear/config.json` underneath,
   * where the brief already names this field.
   */
  readonly transform?: boolean
  /**
   * Which files the transform touches. Default `['**\/*.jsx', '**\/*.tsx']`.
   *
   * **Relative patterns resolve against the git root**, not the Vite root and not `cwd` —
   * the same root the stamped paths themselves are relative to. In a monorepo that is what
   * lets one dev server stamp a shared `packages/ui` component it imports from outside its
   * own Vite root, which anchoring to the Vite root would silently skip.
   */
  readonly include?: FilterPattern
  /**
   * Files the transform skips even when {@link DogearOptions.include} matches. Default
   * `['**\/node_modules/**']`; setting this replaces that rather than extending it, so
   * keep the `node_modules` entry unless you mean to lose it.
   */
  readonly exclude?: FilterPattern
}

/** What `configureServer` learned, and `transformIndexHtml` needs. */
interface Injection {
  readonly endpoint: string
  readonly config: ClientConfig
}

/** What `configureServer` learned, and the `transform` hook needs — C1 (#15). */
interface Stamping {
  readonly gitRoot: string
  readonly matches: (id: string) => boolean
}

/**
 * dogear's Vite plugin.
 *
 * It injects the dev script (A1), serves the annotations endpoint (A2), and stamps
 * `data-dogear-src` onto host JSX elements (C1).
 *
 * **`apply: 'serve'`** is the primary production defense, not a convenience. The plugin
 * does not exist during `vite build` at all, which covers the script injection and the
 * attribute transform with one line. Every other layer in the brief's "Keeping it out of
 * production" is a backstop behind this one — including the sentinel below, which exists
 * so that `npm run check:leak` has something to catch if this line is ever wrong.
 *
 * **`enforce: 'pre'`** is load-bearing for the C1 transform below. Vite runs `pre` plugins
 * before the React plugin compiles JSX, so `stampSource` sees real JSX syntax rather than
 * already-compiled `jsx()` calls. `stamp.integration.test.ts` is what holds that ordering
 * in place — it asserts the attribute survives into the compiled output.
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

  /**
   * Set by `configureServer`, read by `transform`. `undefined` means "do not stamp".
   *
   * Separate from `injection` because the two answer different questions — `transform:
   * false` disables stamping while leaving the overlay fully injected — but assigned under
   * the same preconditions, and that part is not optional. No git root means no endpoint
   * and no tag; it must also mean no stamp, because an attribute naming a path relative to
   * a repository dogear could not find is worse than no attribute at all.
   *
   * Safe as closure state for the same two reasons `injection` is: Vite awaits every
   * `configureServer` hook before it serves anything, and `dogear()` returns a fresh object
   * per call.
   */
  let stamping: Stamping | undefined

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
      // B6 (#13). Before `normaliseEndpoint`, so a project that has turned dogear off cannot
      // be stopped by a dogear misconfiguration — `enabled: false` and a bad `endpoint` in
      // the same config should start the dev server, not throw at it.
      //
      // `injection` is left undefined, so `transformIndexHtml` emits nothing. Coupling the
      // two is the same rule the git-root branch below states: no endpoint means no tag,
      // because a tag whose import 404s is a worse failure than absence.
      if (options.enabled === false) {
        server.config.logger.info(
          '[dogear] disabled by config (`enabled: false`). No script is injected and no ' +
            'endpoint is served.',
        )
        return
      }

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

      // One line, once, naming both bindings — B6's (#13) other discovery vector.
      //
      // The panel's hint line only reaches someone who already has annotations queued, and
      // the developer most likely to want the kill switch is the one who has never
      // deliberately opened dogear at all. The terminal is where they are looking.
      server.config.logger.info(
        `[dogear] ready — ${config.modifier}-click an element to annotate, ` +
          'Ctrl+Alt+D to turn dogear off.',
      )

      // C1 (#15). Resolved here rather than per-request because neither the git root nor
      // the option patterns can change while this process lives, and `createFilter`
      // compiles its globs once.
      //
      // `resolve: gitRoot` is the load-bearing argument. Left to itself `createFilter`
      // resolves relative patterns against `process.cwd()`, which is wherever npm happened
      // to start the dev server — in a workspace that is the package directory, not the
      // repo. Anchoring to the git root instead makes one root govern the whole feature:
      // the globs a user writes and the paths the attribute carries mean the same thing.
      if (options.transform !== false) {
        stamping = {
          gitRoot,
          matches: createFilter(
            options.include ?? DEFAULT_INCLUDE,
            options.exclude ?? DEFAULT_EXCLUDE,
            { resolve: gitRoot },
          ),
        }
      }

      // Assigned last, after the endpoint that may throw and after the middleware is
      // registered — so there is no window in which the tag is injected but the route that
      // serves its import is not.
      injection = { endpoint, config }
    },

    /**
     * The JSX attribute transform — C1 (#15).
     *
     * Thin by design: every decision that could be wrong lives in `stampSource`, which is a
     * pure function over strings and is tested as one. This hook only decides *whether* to
     * call it.
     *
     * Virtual modules are skipped by their leading NUL — the id is a plugin's private
     * namespace rather than a path on disk, so there is nothing for an agent to open even
     * when the contents happen to be JSX.
     */
    transform(code, id) {
      if (stamping === undefined) return null
      if (id.startsWith('\0')) return null
      if (!stamping.matches(id)) return null

      return stampSource(code, id, stamping.gitRoot)
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
