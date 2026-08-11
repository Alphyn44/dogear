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

/** Counterpart to `isCurrentHostAllowed` in ./index.ts. Always denies. */
export function isCurrentHostAllowed(): boolean {
  return false
}
