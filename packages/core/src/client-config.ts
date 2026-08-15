/**
 * How configuration reaches the browser half — F4 (#34).
 *
 * Split from ./client.ts, which **self-starts on import**: it mounts an overlay as a side
 * effect, so nothing may import it to reach a helper. This module is pure, so both core's own
 * tests and @dogear/vite's drift test can drive the real decoder rather than a
 * reimplementation of it.
 */

import type { InitOptions } from './options.js'

/**
 * The query parameter @dogear/vite encodes config into.
 *
 * One JSON parameter rather than one per field. The decoded object then stays structurally
 * identical to the one the plugin builds, so the assignability proof in the plugin's
 * `client.test.ts` compares a real `ClientConfig` against a real `InitOptions` — and B5 (#12)
 * adds `endpoint` by adding a field, with no change to the transport. Per-field parameters
 * would need type coercion for each one here, and ad-hoc encoding rules the moment E7 (#40)
 * passes `hosts` through as an array.
 */
export const CONFIG_PARAM = 'config'

/**
 * Read `?config=<json>` off a module URL.
 *
 * Takes the URL rather than reading `import.meta.url` itself, so it is testable without a
 * module loader. ./client.ts supplies the real one.
 *
 * **Anything unreadable falls back to the defaults rather than throwing.** A malformed URL is
 * a bug in the plugin that produced it, and a dev tool throwing during page load has broken
 * the very app it exists to help you inspect — the same split `resolveOptions` makes, and for
 * the same reason.
 */
export function readConfig(url: string): InitOptions {
  let raw: string | null
  try {
    raw = new URL(url).searchParams.get(CONFIG_PARAM)
  } catch {
    return {}
  }

  if (raw === null || raw === '') return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  // `typeof null === 'object'`, and an array would spread into nonsense. Both are rejected
  // rather than coerced: config that did not survive the wire should read as absent, not as
  // whatever the shape happened to be.
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as InitOptions)
    : {}
}
