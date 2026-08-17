/**
 * The inert build of @dogear/core.
 *
 * package.json's `exports` map routes both the `production` condition and the
 * catch-all `default` here, so a bundler that has never heard of dogear's
 * `development` condition gets this file rather than a live overlay. That is layer 3
 * of the five in the brief's "Keeping it out of production" — a backstop behind
 * `apply: 'serve'`, not a substitute for it.
 *
 * Every export in ./index.ts must have a counterpart here. A missing one is not a
 * type error at build time — it is an undefined import that only appears in a
 * production bundle, which is the worst possible place for a dev tool to fail.
 */

import type { InitContext } from './init.js'
import type { InitOptions, Teardown } from './options.js'

/** Counterpart to the `IS_NOOP` in ./index.ts, which is `false`. */
export const IS_NOOP = true

/**
 * F3's guard, inert.
 *
 * These are hand-written rather than `export … from './host.js'`, and the duplication is
 * the point. Re-exporting would ship the whole host matcher — CIDR arithmetic, suffix
 * rules, the default list — into every correct production bundle, which is the exact
 * outcome layer 3 exists to prevent. It would also leave the inert module answering `true`
 * for `localhost`, so a production build served from a dev machine would report a host as
 * allowed while being incapable of doing anything about it.
 *
 * Denying unconditionally is the honest answer for a module that cannot initialize
 * anything: there is no host on which this build will run.
 */

/** Counterpart to `DEFAULT_HOSTS` in ./index.ts. Nothing is allowed here. */
export const DEFAULT_HOSTS: readonly string[] = Object.freeze([])

/**
 * Counterpart to `isAllowedHost` in ./index.ts. Always denies, whatever it is handed.
 *
 * The parameters are kept, unused, so this is a drop-in for the real signature rather than
 * something a caller has to be typed against differently. The leading underscores are what
 * keeps `noUnusedParameters` happy.
 */
export function isAllowedHost(_hostname: string, _hosts?: readonly string[]): boolean {
  return false
}

/**
 * Counterpart to `isCurrentHostAllowed` in ./index.ts. Always denies.
 *
 * The parameter is mirrored for the reason spelled out under `init` below: TypeScript would
 * accept the shorter signature, and then `isCurrentHostAllowed(hosts)` would compile against
 * the dev build and fail against the production one. E7 (#40) added it.
 */
export function isCurrentHostAllowed(_hosts?: readonly string[]): boolean {
  return false
}

/**
 * Counterpart to `init` in ./index.ts. Starts nothing.
 *
 * **It must return a function**, and that is the whole reason this has a body rather than
 * being `() => undefined`. The idiom `init()` is documented under is
 * `const stop = init(); …; stop()`, and F1's layer 2 fixture uses the dynamic form
 * `import('@dogear/core').then((m) => m.init())`. A noop returning `undefined` turns that
 * into `stop is not a function` — a crash, in a production bundle, from the module whose
 * entire job is to make production a no-op.
 *
 * `import type` above is the only import this file may have; a value import would pull the
 * overlay into `dist/noop.js`, which is precisely what layer 3 exists to prevent.
 * `index.test.ts` enforces that mechanically, because the leak gate cannot see it: a
 * bundled overlay carries no sentinel and would pass every content scan.
 *
 * **The second parameter is mirrored even though nothing here reads it.** TypeScript would
 * accept the shorter signature — a function of one parameter is assignable to one of two —
 * but then `init(options, context)` would compile against the dev build and fail against the
 * production one, which is exactly the dev/prod divergence F1 exists to stop. B6 (#13) added
 * it; see ./init.ts.
 */
export function init(_options?: InitOptions, _context?: InitContext): Teardown {
  return () => {}
}
