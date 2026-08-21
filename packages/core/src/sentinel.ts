/**
 * The production-leak sentinel — layer 4 of the five in the brief's "Keeping it out of
 * production".
 *
 * Nothing emits this yet. A1's injected `<script>` is its first real carrier, at which
 * point core gains a `./sentinel` subpath export so dogear-vite can reach it. Until
 * then this is a constant waiting for its consumer, not dead code: `scripts/check-leak.ts`
 * already imports it, and the whole leak check is defined in terms of it.
 *
 * DELIBERATELY NOT RE-EXPORTED FROM ./index.ts, and this is the subtle part. ./noop.ts
 * mirrors index.ts's public surface, and the noop is precisely what a production build
 * resolves to. Making the sentinel public would therefore push the literal string into
 * every correct production build, and the leak check would fire on a healthy repo. Keep
 * it internal and there is nothing for noop.ts to mirror.
 *
 * The value is chosen to be unmistakable in a minified bundle. Note that the word
 * "dogear" on its own is NOT sufficient as a marker — the example app's own visible copy
 * contains it, so a grep for the product name false-positives. That is exactly why a
 * distinct sentinel exists.
 */
export const SENTINEL = '__DOGEAR_DEV_ONLY__'
