/**
 * The dev-server client entry — the file @dogear/vite actually serves.
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
import { init } from './init.js'
import { SENTINEL } from './sentinel.js'

/**
 * `window.__dogear` survives from M0, so the "did it run?" console check developers already
 * know still works — and it carries `stop`, the teardown `init()` returns, which makes B6's
 * (#13) "detached, not ignored" criterion provable by hand a milestone early.
 *
 * `globalThis` rather than `window`, matching how `isCurrentHostAllowed` reads
 * `globalThis.location`: core is the browser half but never assumes a DOM global exists.
 */
;(globalThis as { __dogear?: unknown }).__dogear = {
  sentinel: SENTINEL,
  stop: init(readConfig(import.meta.url)),
}
