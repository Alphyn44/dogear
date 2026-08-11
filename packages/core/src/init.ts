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
import { createSession } from './session.js'

/**
 * Start dogear. Returns the function that stops it.
 *
 * ```js
 * import { init } from '/__dogear/client.js'
 * const stop = init({ modifier: 'alt' })
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
export function init(options?: InitOptions): Teardown {
  // First line, before a single listener or node exists — F3 (#7), layer 5. If every
  // structural layer above has failed and this module is live on a real user's site, the
  // only correct behaviour is to do nothing at all, and to do it silently: a
  // `[dogear] refusing to initialize` warning would announce a dev tool on the one page it
  // must be invisible on. See ./host.ts.
  if (!isCurrentHostAllowed()) return () => {}

  const registry = createListenerRegistry()
  const overlay = createOverlay()

  createSession({ registry, overlay, options: resolveOptions(options) })

  let disposed = false

  return () => {
    if (disposed) return
    disposed = true

    // Listeners first. Detaching before removing nodes means no in-flight handler can
    // re-mount the host after it has gone — the reverse order leaves a one-frame window
    // where a scroll event remounts an overlay that is supposed to be dead.
    registry.detachAll()
    overlay.destroy()
  }
}
