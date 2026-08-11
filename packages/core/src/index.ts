/**
 * dogear's browser half.
 *
 * Almost nothing lives here yet: the overlay is M1 (B1–B7) and source resolution is M2
 * (C1–C3). What exists now is the flag the packaging depends on — a way to tell this
 * module apart from the production noop — and F3's hostname guard, which has no caller
 * until B1 writes the `init()` that must consult it first.
 *
 * Every export here needs a counterpart in ./noop.ts; `index.test.ts` compares the two
 * surfaces and fails otherwise.
 */

export { DEFAULT_HOSTS, isAllowedHost, isCurrentHostAllowed } from './host.js'

/**
 * `false` here, `true` in the noop build.
 *
 * The swap is done entirely by the `exports` map in package.json (F1, layer 3); this
 * flag is not what performs it. It exists so the swap is *observable* — otherwise
 * "unknown conditions resolve to an inert module" is a claim sitting in a JSON file
 * with nothing able to prove it. F1 asserts against this.
 */
export const IS_NOOP = false
