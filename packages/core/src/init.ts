/**
 * dogear's entry point in the browser.
 *
 * Assembly only — every decision it makes lives in the module it delegates to. What is
 * worth reading here is the *order*, which is load-bearing twice: the host check comes
 * before anything observable happens, and the teardown reverses everything.
 */

import { isCurrentHostAllowed } from './host.js'
import { createListenerRegistry } from './listeners.js'
import type { InitOptions, Teardown } from './options.js'
import { resolveOptions } from './options.js'
import { createOverlay } from './overlay.js'
import type { Queue } from './queue.js'
import { createQueue } from './queue.js'
import { createSession } from './session.js'

/**
 * What cannot travel on {@link InitOptions} — either because it is a function, or because it
 * has to **outlive one session**.
 *
 * Options cross from @dogear/vite as JSON on a query string, so that type can only hold data,
 * and only data that survives `JSON.stringify`. B6 (#13) needs two things that do not: a
 * callback, and the batch itself.
 *
 * A second optional parameter rather than a richer return value: `init()`'s return type is
 * mirrored by `noop.ts` and depended on by F1 layer 2's gated-import fixture, and a dev-only
 * toggle is not worth spending production-safety machinery on. Every existing caller and the
 * documented `const stop = init()` idiom are unaffected.
 */
export interface InitContext {
  /**
   * The user asked dogear to turn itself off — the panel's button, or the chord.
   *
   * dogear does **not** act on this itself. It cannot: the teardown belongs to whoever called
   * `init()`, and a session that tore down its own creator would leave the controller holding
   * a stale handle and reporting that dogear was still running. So this reports the intent and
   * the caller decides, which is the same split the panel and the session already use one
   * level down.
   */
  readonly onDisable?: () => void
  /**
   * The batch to adopt, rather than starting empty.
   *
   * This is what makes B6's kill switch lossless. The queue used to live inside the session,
   * so a teardown destroyed it and disabling had to refuse whenever anything was pending;
   * owned from above, it survives the cycle and the rebuilt session picks it up with the
   * badge already counting. Also covers `__dogear.stop()` → `start()`, which used to eat an
   * unsent batch silently.
   *
   * Omitted for a bare `init()`, which gets a fresh one and behaves exactly as before.
   */
  readonly queue?: Queue
}

/**
 * Start dogear. Returns the function that stops it.
 *
 * ```js
 * import { init } from '/__dogear/client.js'
 * const stop = init({ modifier: 'alt', endpoint: '/__dogear' })
 * ```
 *
 * **The returned teardown is the whole of B6's (#13) architecture.** It removes every
 * listener and every node, so "detach, don't ignore" is true from the first day rather than
 * retrofitted onto handlers that were written assuming they could early-return. B6 adds a
 * toggle, a keyboard shortcut, and `localStorage` on top of this; it does not have to touch
 * anything below it. @dogear/vite exposes the result as `window.__dogear.stop`, so the
 * property is provable by hand in a console today.
 *
 * Calling the teardown twice is safe.
 */
export function init(options?: InitOptions, context?: InitContext): Teardown {
  // First line, before a single listener or node exists — F3 (#7), layer 5. If every
  // structural layer above has failed and this module is live on a real user's site, the
  // only correct behaviour is to do nothing at all, and to do it silently: a
  // `[dogear] refusing to initialize` warning would announce a dev tool on the one page it
  // must be invisible on. See ./host.ts.
  if (!isCurrentHostAllowed()) return () => {}

  const resolved = resolveOptions(options)

  // B6's (#13) hard off, in the same position and for a related reason: whatever "do
  // nothing" means, it has to mean it before anything observable has happened. Silent too —
  // a host that passed `enabled: false` does not need telling.
  //
  // Note @dogear/vite never reaches this: a disabled plugin injects no script, so there is
  // no page to bail on. This is the library entry's path.
  if (!resolved.enabled) return () => {}

  const registry = createListenerRegistry()
  const overlay = createOverlay()

  const session = createSession({
    registry,
    overlay,
    options: resolved,
    queue: context?.queue ?? createQueue(),
    // Defaulted here rather than made required, so a host calling `init()` bare still gets a
    // working overlay — the chord and the button simply do nothing, which is the honest
    // behaviour when nobody is listening for the intent.
    onDisable: context?.onDisable ?? (() => {}),
  })

  let disposed = false

  return () => {
    if (disposed) return
    disposed = true

    // Async work first, for the same reason listeners come before nodes: B5's (#12) submit
    // can be mid-flight, and its continuation would re-mount the host to show `3 sent`. A
    // `setTimeout` or a settling `fetch` is a handler the registry cannot reach.
    session.dispose()

    // Listeners next. Detaching before removing nodes means no in-flight handler can
    // re-mount the host after it has gone — the reverse order leaves a one-frame window
    // where a scroll event remounts an overlay that is supposed to be dead.
    registry.detachAll()
    overlay.destroy()
  }
}
