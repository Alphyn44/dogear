/**
 * The dev-server client entry — the file dogear-vite actually serves.
 *
 * This exists because of F4 (#34). dogear used to bootstrap itself from an **inline**
 * `<script>` that imported `init` and called it. Any project serving a strict
 * `Content-Security-Policy` in dev — `script-src 'self' 'nonce-…' 'strict-dynamic'` — blocks
 * inline execution outright, so dogear silently did nothing and left a console error that
 * read like a fault in the host app. An external same-origin script satisfies `'self'`, so
 * moving the bootstrap into a served file makes the problem not exist rather than working
 * around it.
 *
 * Two things follow, and both are why this is a separate entry rather than part of index.ts:
 *
 * 1. **Something has to start dogear.** With no inline script there is no caller, so this
 *    module self-starts on import. `index.ts` cannot: it is the library surface, and a module
 *    that mounts an overlay merely because somebody imported it would be indefensible.
 * 2. **The sentinel can be carried honestly.** `sentinel.ts` is deliberately absent from
 *    `index.ts` — `noop.ts` mirrors that surface, and the noop is what production resolves
 *    to, so exporting it would ship the literal into every correct production build. This
 *    entry is in no exports map and has no noop counterpart, so importing the constant costs
 *    production nothing. That restores A1's two carriers: the tag's `data-dogear` attribute,
 *    and this bundle.
 *
 * **This file has side effects and nothing may import it.** Everything reusable lives in
 * ./client-config.ts. `sideEffects: false` in package.json is about the *library* entry and
 * is what lets a bundler drop unused exports; this file is never in a bundler's graph — it is
 * served verbatim over HTTP by the dev server.
 */

import { readConfig } from './client-config.js'
import { createController } from './controller.js'
import { SENTINEL } from './sentinel.js'

/**
 * `window.__dogear` survives from M0, so the "did it run?" console check developers already
 * know still works — and since B1 it has carried `stop`, which is what made B6's (#13)
 * "detached, not ignored" provable by hand a milestone early.
 *
 * B6 adds `start`, and it is not a convenience: disabling detaches every listener and removes
 * every node, so **nothing in the page can turn dogear back on**. This object is the way back,
 * which is why the disable path logs a line naming it. See the brief's Decisions log for why
 * a surviving re-arm listener was rejected.
 *
 * `stop` and `start` are deliberately asymmetric. `stop()` is the B1 teardown — this page
 * only, back on reload. `start()` clears a stored "off", because someone typing it has
 * overridden whatever they chose last time.
 *
 * `globalThis` rather than `window`, matching how `isCurrentHostAllowed` reads
 * `globalThis.location`: core is the browser half but never assumes a DOM global exists.
 */
const controller = createController(readConfig(import.meta.url))

;(globalThis as { __dogear?: unknown }).__dogear = {
  sentinel: SENTINEL,
  stop: () => {
    controller.stop()
  },
  start: () => {
    controller.start()
  },
  get running() {
    return controller.running
  },
}

// Last, so `__dogear` exists before anything the overlay does can throw — the console handle
// is most useful in exactly the case where startup went wrong.
if (!controller.boot()) {
  // The one line that keeps a one-way switch from being a dead end. `info`, not `warn`:
  // nothing is broken, and this is a state the developer chose.
  console.info('[dogear] disabled. Run __dogear.start() to turn it back on.')
}
