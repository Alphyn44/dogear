/**
 * dogear's browser half.
 *
 * A barrel, deliberately thin. The surface is one function — {@link init} — plus F3's
 * hostname guard, which `init` is the first caller of. The overlay it assembles is B1/B2/B7
 * (#8, #9, #14); the in-memory queue and submit are B3–B5, and source resolution is M2.
 *
 * Every *value* export here needs a counterpart in ./noop.ts; `index.test.ts` compares the
 * two surfaces at runtime and fails otherwise. Type-only exports are erased and need none.
 */

export { DEFAULT_HOSTS, isAllowedHost, isCurrentHostAllowed } from './host.js'
export { init } from './init.js'
export type { InitOptions, Modifier, Teardown } from './options.js'

/**
 * `false` here, `true` in the noop build.
 *
 * The swap is done entirely by the `exports` map in package.json (F1, layer 3); this
 * flag is not what performs it. It exists so the swap is *observable* — otherwise
 * "unknown conditions resolve to an inert module" is a claim sitting in a JSON file
 * with nothing able to prove it. F1 asserts against this.
 */
export const IS_NOOP = false
