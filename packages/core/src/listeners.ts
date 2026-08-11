/**
 * The one place in @dogear/core allowed to call `addEventListener`.
 *
 * B6's (#13) settled rule is "detach, don't ignore" — an event handler that runs and decides
 * to do nothing is still an event handler that ran, and it still shows up in the behaviour
 * you were trying to test. That is a claim about *every* listener, which makes it a
 * structural requirement rather than a feature: a single listener attached ad hoc somewhere
 * else is enough to falsify it, and finding one by audit later is exactly the retrofit B6
 * should not have to do.
 *
 * So `init()` creates exactly one registry and threads it everywhere, no module builds its
 * own, and `listeners.test.ts` reads the rest of `src/` off disk and fails if any other file
 * contains `addEventListener(`. The same genre of guard as
 * `packages/vite/src/sentinel.test.ts`: cheap, mechanical, and it catches the case a code
 * review would wave through.
 */

/**
 * Both maps, because no single built-in covers what the overlay needs: `blur` and `resize`
 * are `WindowEventMap`, `visibilitychange` is `DocumentEventMap`, and the pointer and
 * keyboard events are in both.
 */
type DogearEventMap = WindowEventMap & DocumentEventMap

interface Registration {
  readonly target: EventTarget
  readonly type: string
  readonly handler: EventListener
  readonly options: AddEventListenerOptions | undefined
}

export interface ListenerRegistry {
  on<K extends keyof DogearEventMap & string>(
    target: EventTarget,
    type: K,
    handler: (event: DogearEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void
  /** Remove every listener this registry attached. Idempotent. */
  detachAll(): void
  /** How many listeners are currently attached. For tests. */
  readonly size: number
}

export function createListenerRegistry(): ListenerRegistry {
  const registrations: Registration[] = []

  return {
    on(target, type, handler, options) {
      const listener = handler as EventListener
      target.addEventListener(type, listener, options)
      registrations.push({ target, type, handler: listener, options })
    },

    detachAll() {
      // Reverse order, so teardown unwinds in the mirror of attachment. Nothing here
      // currently depends on ordering; it costs nothing and stops a future listener that
      // does from having a latent bug.
      for (let index = registrations.length - 1; index >= 0; index -= 1) {
        const registration = registrations[index]
        if (registration === undefined) continue

        // The options object is passed back verbatim, and this is the load-bearing line.
        // `capture` is part of a listener's identity: a listener added with
        // `{ capture: true }` is NOT removed by `removeEventListener(type, handler)`, and
        // the call fails silently rather than throwing. Every listener the overlay attaches
        // to `window` is a capture listener, so getting this wrong would leave the entire
        // suppression set live after teardown — "ignored, not detached", precisely inverted.
        registration.target.removeEventListener(
          registration.type,
          registration.handler,
          registration.options,
        )
      }

      // Truncate rather than reassign, so `size` below stays correct and a second
      // detachAll() is a no-op by construction rather than by a guard someone can forget.
      registrations.length = 0
    },

    get size() {
      return registrations.length
    },
  }
}
