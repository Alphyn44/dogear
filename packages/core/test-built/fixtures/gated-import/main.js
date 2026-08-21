/**
 * F1 layer 2 — the gated dynamic import, as a consumer without our Vite plugin writes it.
 *
 * This file is a fixture, not an example. It is built in production mode by
 * `npm run build:fixtures`, and `scripts/gate/no-leaks.test.ts` then asserts that the marker
 * string below is ABSENT from the output. If dead-code elimination did its job, the whole
 * branch went with it and the marker went too.
 *
 * The marker is why this fixture exists at all. Scanning the output for a package specifier
 * would pass even on a build that shipped dogear: the exports map sends a production build to
 * `dist/noop.js`, and the noop carries neither the sentinel nor a package specifier, so a
 * bundled-inline noop is invisible to those rules. A literal that lives *inside* the gated
 * block is not.
 *
 * That the marker sits inside the block rather than beside it is deliberate — a top-level
 * unused constant would be tree-shaken on its own merits, which would prove nothing about
 * the branch.
 *
 * This also exercises layers 2 and 3 together: a production build sets the `production`
 * condition, so even had elimination failed, only the inert module could have resolved.
 */

// A live statement, so the build always emits a JS chunk. A bundle that turned out empty
// would make "the marker is absent" true for the wrong reason.
document.body.textContent = 'dogear F1 layer 2 fixture'

if (import.meta.env.DEV) {
  import('dogear-core').then((core) => {
    document.title = `dogear-layer2-marker-must-not-ship:${core.IS_NOOP}`
  })
}
