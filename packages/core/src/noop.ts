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
