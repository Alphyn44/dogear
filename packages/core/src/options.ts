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

import { DEFAULT_HOSTS } from './host.js'

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
   * The brief's Config block (`modifier`) is a `.dogear/config.json` key — E4 (#29) writes
   * that file, E7 (#40) reads it. Plugin options win over the file, so this is the layer that
   * wins
   * either way: E7 layers the file *underneath* @dogear/vite's `modifier` option, and
   * neither reaches past this.
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
  /**
   * B6's (#13) hard off. Default `true`.
   *
   * `false` makes {@link import('./init.js').init} bail before a listener or a node exists,
   * beside F3's host guard. **@dogear/vite never sends this** — a disabled plugin injects no
   * script at all, so there is nothing in the browser to configure. It is here for the
   * library entry, and so that "enabled: false has the same effect from config" is true at
   * both levels rather than only at the one that happens to be wired.
   *
   * Distinct from the `localStorage` preference in ./preference.ts, which is the developer's
   * per-origin choice. This one is the project's, and it wins — see the brief.
   */
  readonly enabled?: boolean
  /**
   * F3's allow-list — the hosts dogear will run on. Default {@link DEFAULT_HOSTS}.
   *
   * **It replaces the defaults rather than extending them**, which is the contract ./host.ts
   * has always documented and E7 (#40) is what finally supplies it: `.dogear/config.json`'s
   * `hosts` key, layered by @dogear/vite and serialised onto the config parameter. An empty
   * array is honoured as "nowhere" rather than read as absent.
   *
   * Unlike every other field here, this one has no plugin option above it. It is repo-wide
   * safety configuration and belongs in the repo-wide committed file; @dogear/vite omits the
   * key entirely when that file does not set one, so the fallback below is what runs in the
   * ordinary case.
   */
  readonly hosts?: readonly string[]
}

/**
 * {@link InitOptions} with every default applied. What core actually reads.
 *
 * **`hosts` is deliberately not here**, though it is on `InitOptions`. This type is what
 * `createSession` receives, and every field on it is one the session reads; the allow-list is
 * consumed once, by the host guard, before a session exists at all. {@link resolveHosts} is
 * its resolver for that reason — a field threaded through a consumer that ignores it would
 * make this type stop meaning what its name says.
 */
export interface ResolvedOptions {
  readonly modifier: Modifier
  readonly endpoint: string
  readonly enabled: boolean
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
  const enabled = options?.enabled
  return {
    modifier:
      modifier !== undefined && MODIFIERS.includes(modifier)
        ? modifier
        : DEFAULT_MODIFIER,
    endpoint:
      typeof endpoint === 'string' && endpoint !== '' ? endpoint : DEFAULT_ENDPOINT,
    // Only a literal `false` turns dogear off. A non-boolean that survived the query string
    // reads as enabled — the same safe direction ./preference.ts takes, and for the same
    // reason: a dev tool that is unexpectedly on can be switched off, while one that is
    // unexpectedly absent looks like it is broken.
    enabled: enabled !== false,
  }
}

/**
 * F3's allow-list for this page — E7 (#40).
 *
 * Separate from {@link resolveOptions} because it is consumed at a different moment by a
 * different caller: `init()` hands it straight to the host guard and then never refers to it
 * again, while everything `resolveOptions` returns travels on into the session.
 *
 * **All-or-nothing, and silent either way.** Every other resolution in this file falls back
 * per-field; this one rejects a malformed list wholesale, because half of a safety list is
 * not a safety list — dropping the bad entries would silently *widen* whatever the author was
 * narrowing. Silent because the one page that can reach this code is a page where every
 * structural layer already failed, and a console line there would announce a dev tool on the
 * one page it must be invisible on (see ./host.ts). Reporting belongs to @dogear/vite, which
 * reads the file in a terminal, drops bad entries where it can name them, and sends only what
 * survived — so anything malformed *here* was hand-written onto the query parameter.
 *
 * An empty array is well-formed and survives as itself: "nowhere" is a thing
 * `.dogear/config.json` is allowed to say, and reading it as absence would override someone
 * who meant it.
 */
export function resolveHosts(options: InitOptions | undefined): readonly string[] {
  const hosts = options?.hosts
  return Array.isArray(hosts) && hosts.every((host) => typeof host === 'string')
    ? hosts
    : DEFAULT_HOSTS
}
