/**
 * B6 (#13) — the start/stop cycle.
 *
 * `init()` builds dogear once and hands back the function that removes it. That was enough
 * through B5, when nothing ever came back after stopping. B6 needs the cycle to be
 * repeatable and needs somewhere to keep the preference, and this is that place.
 *
 * **Why this is a module and not four lines in ./client.ts.** The dev-client entry is where
 * `window.__dogear` is built, and it is the obvious home — but it self-starts on import, so
 * nothing may import it, so nothing can test it. B6's entire claim is "when disabled,
 * listeners are detached, not ignored", and the assertion that proves it is
 * `registry.size === 0`. Putting the cycle behind an importable factory is what lets that be
 * a test instead of a promise. ./client.ts is left as a wire.
 *
 * **`init()` is untouched**, deliberately. Its return type is mirrored by `noop.ts` and
 * depended on by F1 layer 2's gated-import fixture, and changing a public signature to add a
 * dev-only toggle would spend production-safety machinery on a convenience.
 *
 * **Four verbs, because there are four intents.** `stop()` and `disable()` both tear down and
 * differ only in whether they persist — see the brief for why merging them was rejected.
 * `boot()` and `start()` both build and differ only in whether they consult the preference:
 * one is "the page loaded", the other is "the developer asked".
 */

import { init } from './init.js'
import type { InitOptions, Teardown } from './options.js'
import { isEnabled, setEnabled } from './preference.js'
import type { Queue } from './queue.js'
import { createQueue } from './queue.js'

export interface Controller {
  /** Is dogear currently built and attached? */
  readonly running: boolean
  /**
   * The batch, which **outlives any one session**.
   *
   * Exposed for the same reason `Session.queue` is: so the disable/re-enable cycle can be
   * tested against the annotations that actually survived rather than against a badge's
   * rendering of a count. Not part of `dogear-core`'s public surface — ./index.ts exports
   * neither this type nor `createController`.
   */
  readonly queue: Queue
  /**
   * Start if the stored preference allows. What page load calls.
   *
   * Returns whether it started, so the caller can say something about a page that came up
   * disabled without duplicating the preference read.
   */
  boot(): boolean
  /**
   * Start, and clear a stored "off". The developer asking for it outranks what they asked
   * for last time — this is the documented way back from a disable.
   */
  start(): void
  /**
   * Tear down for this page only. What `__dogear.stop()` has meant since B1: nothing is
   * persisted, so a reload brings dogear back.
   */
  stop(): void
  /** Tear down **and** remember it. What the toggle and the shortcut call. */
  disable(): void
}

export function createController(options?: InitOptions): Controller {
  /**
   * The single source of truth for "is it running". Holding the teardown rather than a
   * boolean beside it means the two cannot disagree, and makes double-start and double-stop
   * no-ops by construction rather than by a guard in each of four methods.
   */
  let teardown: Teardown | null = null

  /**
   * Created once, here, and handed to every session this controller builds.
   *
   * This is the line that makes the kill switch lossless. When the queue lived inside the
   * session, a teardown destroyed the only copy of the user's work — so disabling had to
   * refuse while anything was pending, which in turn made the panel's Disable button
   * unreachable in every state where it would have worked. Owning it one level up removes
   * the refusal, the button's dead end, and the silent data loss in `stop()`, all at once.
   *
   * It costs nothing structurally: ./queue.ts is pure data with no DOM, so nothing about
   * "detach, don't ignore" or B7's (#14) zero-nodes is weakened by keeping it alive. While
   * disabled there is still not one listener and not one node — just a JavaScript object
   * holding some text, which is what a reload clears.
   */
  const queue: Queue = createQueue()

  function build(): void {
    if (teardown !== null) return
    // The session reports the toggle; `disable` below decides what it means. Routed through
    // the same function the console and the panel reach, so there is exactly one path that
    // both persists and tears down — and `running` cannot go stale behind a session that
    // stopped itself.
    teardown = init(options, { onDisable: disable, queue })
  }

  function tearDown(): void {
    if (teardown === null) return
    // Cleared first. `init()`'s teardown is itself idempotent, but a throw from inside it
    // would otherwise leave this holding a function that has already half-run — and the next
    // `start()` would refuse, because it looks like dogear is still up.
    const stop = teardown
    teardown = null
    stop()
  }

  function disable(): void {
    // Persisted before the teardown, not after: `init()`'s teardown detaches listeners and
    // removes nodes, and if anything in that throws, the preference the user just expressed
    // should still have been recorded. The worst case is then a half-torn-down page that
    // comes back disabled, rather than one that comes back on.
    setEnabled(false)
    tearDown()
  }

  return {
    queue,

    get running() {
      return teardown !== null
    },

    boot() {
      // The options flag is checked by `init()` itself, alongside F3's host guard, so a
      // `dogear({ enabled: false })` build bails there rather than here. This is only the
      // stored, per-origin preference.
      if (!isEnabled()) return false

      build()
      return true
    },

    start() {
      setEnabled(true)
      build()
    },

    stop() {
      tearDown()
    },

    disable,
  }
}
