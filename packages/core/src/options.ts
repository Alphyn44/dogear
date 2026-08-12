/**
 * What a host passes into {@link import('./init.js').init}, and the resolved form the rest
 * of core reads.
 *
 * The types here are the *contract with @dogear/vite*, which cannot import them. The plugin
 * hand-writes a copy in `packages/vite/src/client.ts` for the same reason it hand-writes
 * SENTINEL — resolving `@dogear/core` by name goes through the exports map to `dist/`, which
 * would make `npm run typecheck` depend on a prior `npm run build`, and a relative import
 * into this directory is refused by the plugin's `rootDir: "src"`. See the brief's Decisions
 * log. The copy is guarded: `packages/vite/src/client.test.ts` imports this file relatively
 * (test files sit outside the build tsconfig) and fails on drift.
 */

/**
 * The key held to arm dogear.
 *
 * Four, because those are the four modifier flags a `MouseEvent` carries. `'meta'` on
 * Windows is the Start key, which the OS grabs on keyup — usable, but not a good default
 * there.
 */
export type Modifier = 'alt' | 'ctrl' | 'meta' | 'shift'

/**
 * What {@link import('./init.js').init} hands back: call it and dogear is gone.
 *
 * Named rather than inlined because three files return one and B6 (#13) will build its kill
 * switch on top of it.
 */
export type Teardown = () => void

/** Everything a host may configure. Every field optional; core supplies every default. */
export interface InitOptions {
  /**
   * Which key arms the overlay. Default `'alt'`.
   *
   * The brief's Config block (`modifier`) is E4's (#29) `.dogear/config.json` key. Plugin
   * options win over the file, so this is the layer that wins either way — E4 layers the
   * file *underneath* @dogear/vite's `modifier` option, and neither reaches past this.
   */
  readonly modifier?: Modifier
  /**
   * Base path B5's (#12) submit POSTs to — `<endpoint>/annotations`. Default `/__dogear`.
   *
   * The plugin always sends this, and it is already normalised by the time it does (see
   * `normaliseEndpoint`). The default exists for a bare `init()` from the library entry,
   * where there is no plugin to supply one.
   */
  readonly endpoint?: string
}

/** {@link InitOptions} with every default applied. What core actually reads. */
export interface ResolvedOptions {
  readonly modifier: Modifier
  readonly endpoint: string
}

/**
 * The valid {@link Modifier} values, as data.
 *
 * Exported from this module but deliberately **not** from `./index.ts`: it needs no `noop.ts`
 * counterpart that way, and its only outside consumer is the plugin's drift test.
 */
export const MODIFIERS: readonly Modifier[] = Object.freeze([
  'alt',
  'ctrl',
  'meta',
  'shift',
])

export const DEFAULT_MODIFIER: Modifier = 'alt'

/**
 * dogear's copy of @dogear/vite's `DEFAULT_ENDPOINT`, and the same duplication `MODIFIERS`
 * already carries — the two halves cannot import each other (exports map, `rootDir`), so
 * `packages/vite/src/client.test.ts` guards the pair against drift.
 */
export const DEFAULT_ENDPOINT = '/__dogear'

/**
 * Apply defaults, and fall back rather than throw on a value that is not a {@link Modifier}.
 *
 * The split is deliberate and mirrors `normaliseEndpoint`, which @dogear/vite validates in
 * `configureServer` precisely so a bad option cannot take down a build. The *plugin* throws
 * on a bad `modifier`, at config time, in a terminal, where a developer is looking. Core is
 * the browser half: a dev tool that throws during page load has broken the app it was
 * supposed to help you inspect. Same value, two audiences, two failure modes.
 *
 * `endpoint` gets the same treatment for the same reason, with one extra wrinkle: it arrives
 * from a query parameter, so the type says `string` but the value is whatever survived the
 * URL. A non-string or an empty one falls back rather than producing a POST to `undefined`.
 * It is **not** re-normalised here — the plugin ran `normaliseEndpoint` before serialising
 * it, and re-deriving the rule in core would be a second implementation to keep in step.
 */
export function resolveOptions(options: InitOptions | undefined): ResolvedOptions {
  const modifier = options?.modifier
  const endpoint = options?.endpoint
  return {
    modifier:
      modifier !== undefined && MODIFIERS.includes(modifier)
        ? modifier
        : DEFAULT_MODIFIER,
    endpoint:
      typeof endpoint === 'string' && endpoint !== '' ? endpoint : DEFAULT_ENDPOINT,
  }
}
