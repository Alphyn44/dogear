/**
 * B6 (#13) — the one thing dogear remembers about you.
 *
 * A single boolean, per origin, in `localStorage`. Its own module rather than four lines
 * inside ./controller.ts, because the interesting part is not the flag — it is that **every
 * access can throw**, and the handling has to be in one place or it will be right in three
 * of four.
 *
 * **Absence means enabled.** The key is written only to record `false` and is *removed* when
 * dogear is switched back on, so a developer who never touches the toggle has nothing of
 * dogear's in their browser storage. The alternative — writing `'true'` on every load — puts
 * an entry on every machine that has ever loaded a dev server, to record the default.
 *
 * The value is compared to the exact string `'false'`. Anything else in the slot — a stale
 * value from a future version, something another tool wrote, garbage — reads as enabled,
 * which is the safe direction: the failure is a dev tool that is on when you wanted it off
 * and can be turned off again, rather than one that is mysteriously absent.
 */

/** Namespaced, because this shares an origin with the application under development. */
export const PREFERENCE_KEY = 'dogear:enabled'

/** The value stored to mean "off". Absence, or anything else, means on. */
const DISABLED = 'false'

/**
 * The fallback when storage is unavailable.
 *
 * `localStorage` is not a given: Safari's private mode has historically thrown on `setItem`
 * once the quota is exhausted, a sandboxed iframe without `allow-same-origin` throws on mere
 * *access* to the property, and Chrome throws on read when cookies are blocked entirely. All
 * three are reachable from a dev server, none is dogear's fault, and none is worth an
 * exception during page load — a dev tool that throws while the app is booting has broken the
 * thing it exists to help you inspect. Same call `resolveOptions` and `readConfig` make.
 *
 * The cost of degrading is honest and small: the toggle still works, and it stops working
 * *across reloads*, which is the only part storage was buying.
 */
let inMemory: boolean | null = null

/**
 * Read the store, or `undefined` if it cannot be reached.
 *
 * Wrapped around the property access as well as the call, because reading
 * `globalThis.localStorage` is itself what throws in a sandboxed frame.
 */
function read(): string | null | undefined {
  try {
    return globalThis.localStorage?.getItem(PREFERENCE_KEY)
  } catch {
    return undefined
  }
}

/** Is dogear allowed to start? */
export function isEnabled(): boolean {
  const stored = read()

  // Storage unreachable — fall back to whatever this page has been told, defaulting to on.
  if (stored === undefined) return inMemory ?? true

  return stored !== DISABLED
}

/**
 * Record the preference. Always updates the in-memory copy, so a failed write still holds
 * for the rest of the page rather than being silently forgotten a line later.
 */
export function setEnabled(value: boolean): void {
  inMemory = value

  try {
    const store = globalThis.localStorage
    if (store === undefined || store === null) return

    // Removed rather than set to 'true' — see the module docblock.
    if (value) store.removeItem(PREFERENCE_KEY)
    else store.setItem(PREFERENCE_KEY, DISABLED)
  } catch {
    // Deliberately silent. The caller has already had its effect — dogear is off, or on —
    // and "your browser would not let me remember this" is not worth a line in the console
    // of someone else's application.
  }
}

/**
 * Drop the in-memory fallback. **Tests only** — module state outlives a test otherwise, and
 * the fallback is only reachable by making storage throw, which is exactly what those tests
 * do.
 */
export function resetPreferenceCache(): void {
  inMemory = null
}
