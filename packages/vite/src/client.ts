import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { SENTINEL } from './sentinel.js'

/**
 * The plugin half of the browser contract: where @dogear/core's bundle lives on disk, and
 * the one inline `<script>` that loads it.
 *
 * M0 inlined a three-line payload here. B1 (#8) needs the real overlay, which is far too
 * large to re-send inside every HTML response — so the plugin serves the built bundle at
 * `<endpoint>/client.js` and injects a tag that imports it. What stays inline is the call:
 *
 * ```html
 * <script type="module" data-dogear="__DOGEAR_DEV_ONLY__">
 *   import { init } from "/__dogear/client.js"
 *   window.__dogear = { sentinel: "…", stop: init({"modifier":"alt"}) }
 * </script>
 * ```
 *
 * Config crosses as a JSON literal rather than a query string or a data attribute — a module
 * script has `document.currentScript === null`, so the attribute route does not exist, and a
 * literal is the only form that stays typed on this side.
 *
 * The sentinel is still carried BOTH here and on the tag's `data-dogear` attribute. Which of
 * the two a hypothetical leak would preserve is exactly what cannot be predicted, and
 * check:leak is a plain substring scan — a second carrier costs nothing.
 *
 * Emitted as inline `<script>` content, so this text must never contain the sequence
 * `</script>`: the HTML parser would end the element early, whatever the JavaScript meant.
 * Every interpolated value goes through {@link toScriptLiteral}, which makes that structural
 * rather than something to remember.
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

/** Exactly what is serialised into the `init(...)` call. Must satisfy core's `InitOptions`. */
export interface ClientConfig {
  readonly modifier: Modifier
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
  const bundle = join(dist, 'index.js')
  const sourcemap = join(dist, 'index.js.map')

  // The bundle is what matters; a missing sourcemap is a DevTools inconvenience, not a
  // reason to fall back to the stub and tell someone to rebuild. Both are checked here
  // rather than at request time so a missing map is a 404 the route can explain, instead of
  // a readFileSync throwing out of the middleware as an unexplained 500.
  if (!existsSync(bundle)) return undefined

  return { bundle, sourcemap: existsSync(sourcemap) ? sourcemap : undefined }
}

export function buildClientConfig(options: {
  readonly modifier?: Modifier
}): ClientConfig {
  return { modifier: options.modifier ?? DEFAULT_MODIFIER }
}

/**
 * The inline module that loads core and starts it.
 *
 * `window.__dogear` survives from M0, so the "did it run?" console check developers already
 * know still works — and it now carries `stop`, the teardown `init()` returns. That makes
 * B6's (#13) "detached, not ignored" criterion provable by hand a milestone early: type
 * `__dogear.stop()` in a console and dogear's listeners are gone, not quietened.
 *
 * Module scripts execute in document order regardless of when they finish fetching, so
 * `injectTo: 'head-prepend'` still means dogear's listeners are attached before the app's.
 */
export function clientTagSource(endpoint: string, config: ClientConfig): string {
  return `
import { init } from ${toScriptLiteral(`${endpoint}/client.js`)}

window.__dogear = {
  sentinel: ${toScriptLiteral(SENTINEL)},
  stop: init(${toScriptLiteral(config)}),
}
`
}

/**
 * JSON, with `<` escaped so nothing can terminate the script element.
 *
 * `endpoint` is user-supplied and reaches the import specifier, so this is not theoretical:
 * `dogear({ endpoint: '/x"></script><script>' })` would otherwise close the tag early and
 * open one of the caller's choosing. Escaping `<` rather than matching on `</script` handles
 * `<!--` and `<script` too, and it stays valid JavaScript because `\\u003c` in a string
 * literal is just `<`.
 */
function toScriptLiteral(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}
