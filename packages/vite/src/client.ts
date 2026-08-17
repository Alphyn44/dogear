import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * The plugin half of the browser contract: where @dogear/core's dev client lives on disk, and
 * the `<script>` that loads it.
 *
 * M0 inlined a three-line payload here. B1 (#8) replaced it with an inline module that
 * imported the served bundle and called `init` with a config literal. F4 (#34) removed the
 * inline script entirely:
 *
 * ```html
 * <script type="module" data-dogear="__DOGEAR_DEV_ONLY__"
 *         src="/__dogear/client.js?config=%7B%22modifier%22%3A%22alt%22%7D"></script>
 * ```
 *
 * **Why there is nothing inline left.** A strict `Content-Security-Policy` —
 * `script-src 'self' 'nonce-…' 'strict-dynamic'`, increasingly common in dev — blocks inline
 * execution outright, and dogear failed silently with a console error that read like a fault
 * in the host app. An external same-origin script satisfies `'self'`, so no nonce is needed
 * and dogear stays out of the host's CSP configuration entirely.
 *
 * Config therefore rides on the URL, and core reads it from `import.meta.url` — a module
 * script has `document.currentScript === null`, so the data-attribute route does not exist.
 * One JSON parameter rather than one per field, so the object stays structurally identical to
 * core's `InitOptions` and B5 adds a field without touching the transport.
 *
 * The sentinel is still carried twice: on the tag's `data-dogear` attribute, and inside the
 * served bundle, which imports the constant directly (see `packages/core/src/client.ts`).
 * Which of the two a hypothetical leak would preserve is exactly what cannot be predicted,
 * and check:leak is a plain substring scan.
 */

/**
 * dogear's copy of core's `Modifier`, and the same duplication the brief already settled for
 * SENTINEL — see its Decisions log entry.
 *
 * Importing `@dogear/core` by name resolves through the exports map to `dist/`, so
 * `npm run typecheck` would need a prior `npm run build`; typecheck runs on every turn that
 * touches a `.ts` file, which makes that a permanent cost. A relative import of core's source
 * is unavailable too: `tsconfig.build.json` sets `rootDir: "src"` and declaration emit rejects
 * anything above it. And architecturally the plugin never imports dogear's browser half — it
 * emits a `<script>` tag.
 *
 * The duplication is guarded: `client.test.ts` imports core's `options.ts` relatively (test
 * files sit outside the build tsconfig and the tsup entry, so the rootDir rule does not reach
 * them) and fails both on set drift and on the config object ceasing to be assignable to
 * core's `InitOptions`.
 */
export type Modifier = 'alt' | 'ctrl' | 'meta' | 'shift'

export const MODIFIERS: readonly Modifier[] = Object.freeze([
  'alt',
  'ctrl',
  'meta',
  'shift',
])

export const DEFAULT_MODIFIER: Modifier = 'alt'

/**
 * Exactly what is serialised into the config parameter. Must satisfy core's `InitOptions`.
 *
 * `endpoint` is B5's (#12) addition, and it is the case F4's transport was chosen for: one
 * JSON parameter rather than one per field means a new field costs a line here and nothing
 * anywhere else. Core needs it because it POSTs to `<endpoint>/annotations`, and the base
 * path is configurable.
 */
export interface ClientConfig {
  readonly modifier: Modifier
  readonly endpoint: string
  /**
   * F3's allow-list, when `.dogear/config.json` sets one — E7 (#40).
   *
   * **Optional, and absent unless the file said so.** Sending the plugin's own copy of the
   * defaults would *pin* them: a repo whose `@dogear/vite` is a version behind `@dogear/core`
   * would keep overriding core's list with a stale one, having never expressed an opinion
   * about it. That is precisely the failure the brief's E4 entry rejects for writing defaults
   * into the config file, and it applies identically here. Omitted means "core decides",
   * which is the only form under which the two packages can move independently.
   */
  readonly hosts?: readonly string[]
}

/** Absolute paths to core's dev build, resolved once per dev server. */
export interface ClientDist {
  readonly bundle: string
  /** `undefined` if tsup was configured without `sourcemap`. The bundle still serves. */
  readonly sourcemap: string | undefined
}

/**
 * `createRequire` rather than `import.meta.resolve`, and **not named `require`**: esbuild
 * special-cases the identifier `require` and its `.resolve` member, and tsup bundles this
 * file. A different name is unambiguous to the bundler.
 */
const resolveFrom = createRequire(import.meta.url)

/**
 * Find @dogear/core's dev bundle, or `undefined` if it has not been built.
 *
 * **Resolving `@dogear/core/package.json`, not `@dogear/core`.** Resolving the package name
 * from Node names no `development` condition, so it falls through the exports map to
 * `dist/noop.js` — the inert build, which is exactly what we do not want to serve. Reading
 * the manifest's location and joining `dist/index.js` reaches the live build deliberately,
 * and only from inside a dev server process.
 *
 * A dedicated `./dev` subpath on core's exports would have been tidier to read and was
 * rejected for it: that would be a second live entry point any bundler could follow into a
 * production graph, which is precisely the hole F1's layer 3 exists to close. `./package.json`
 * exposes a manifest, not code, so `@dogear/core` still resolves to the noop for every
 * consumer under every condition but `development`.
 */
export function resolveCoreDist(): ClientDist | undefined {
  let manifest: string
  try {
    manifest = resolveFrom.resolve('@dogear/core/package.json')
  } catch {
    return undefined
  }

  const dist = join(dirname(manifest), 'dist')
  // `client.js`, not `index.js`. The library entry has no caller now that nothing is
  // inlined — the served file has to self-start, and that is a separate tsup entry in core.
  // It also carries the sentinel, which `index.js` deliberately cannot.
  const bundle = join(dist, 'client.js')
  const sourcemap = join(dist, 'client.js.map')

  // The bundle is what matters; a missing sourcemap is a DevTools inconvenience, not a
  // reason to fall back to the stub and tell someone to rebuild. Both are checked here
  // rather than at request time so a missing map is a 404 the route can explain, instead of
  // a readFileSync throwing out of the middleware as an unexplained 500.
  if (!existsSync(bundle)) return undefined

  return { bundle, sourcemap: existsSync(sourcemap) ? sourcemap : undefined }
}

/**
 * `endpoint` is required rather than defaulted, unlike `modifier`.
 *
 * `configureServer` has already run it through `normaliseEndpoint` by the time it gets here,
 * and defaulting it a second time would mean this function could hand core a *raw* path the
 * middleware is not actually mounted at — a submit 404ing against dogear's own SPA fallback,
 * with nothing in either half to say why. Core carries `DEFAULT_ENDPOINT` for the bare
 * `init()` case; the plugin's copy of the default lives in ./endpoint.ts, where the
 * middleware reads it.
 */
export function buildClientConfig(options: {
  readonly modifier?: Modifier
  readonly endpoint: string
  readonly hosts?: readonly string[]
}): ClientConfig {
  return {
    modifier: options.modifier ?? DEFAULT_MODIFIER,
    endpoint: options.endpoint,
    // Spread rather than `hosts: options.hosts`, so an unset list leaves the key off the
    // object entirely. `JSON.stringify` would drop an explicit `undefined` anyway, but the
    // object is compared directly by ./client.test.ts's assignability proof and read by
    // ./index.test.ts, and "absent" is the state that means something here.
    ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
  }
}

/** The query parameter core reads its options from. Mirrors core's `CONFIG_PARAM`. */
export const CONFIG_PARAM = 'config'

/**
 * The `src` for the injected tag: the served bundle, with config on the query string.
 *
 * `encodeURIComponent` on the whole JSON blob, so `&`, `=`, `#`, and quotes in a config value
 * cannot break out of the parameter or out of the HTML attribute Vite serialises this into.
 *
 * Module scripts execute in document order regardless of when they finish fetching, so
 * `injectTo: 'head-prepend'` still means dogear's listeners attach before the app's — an
 * external `src` changes nothing about that.
 */
export function clientScriptSrc(endpoint: string, config: ClientConfig): string {
  const encoded = encodeURIComponent(JSON.stringify(config))
  return `${endpoint}/client.js?${CONFIG_PARAM}=${encoded}`
}
