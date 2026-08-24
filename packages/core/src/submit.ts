/**
 * B5 (#12) — the wire. Turning the in-memory batch into a POST, and the server's answer
 * into something the panel can render.
 *
 * Split from ./session.ts for the reason ./queue.ts and `anchorStyle` already are: this has
 * no DOM in it, so it tests in the node environment against a stubbed `fetch` rather than
 * needing happy-dom and a mounted overlay. What is left in the session is the *ordering* —
 * snapshot, clear, announce — which is where the interesting mistakes live.
 *
 * **Nothing here throws.** A submit failing is an ordinary outcome with the queue still
 * intact, and the caller has to render it either way; turning a dead dev server into an
 * unhandled rejection inside a page-load-time dev tool is the failure mode F3 and
 * `resolveOptions` are both written to avoid.
 */

import type { AnnotationDraft, QueueItem } from './queue.js'

/**
 * The only version of the POST contract that exists. Mirrors dogear-vite's
 * `PROTOCOL_VERSION`, which validates against it — the two halves cannot import each other.
 */
export const PROTOCOL_VERSION = 1

/**
 * How long to wait before giving up on the dev server.
 *
 * Same order as the CLI hook's own budget. The failure this exists for is a server that
 * accepted the connection and will never answer: without a deadline the Submit button stays
 * disabled forever, and the only recovery is a reload — which discards the entire in-memory
 * queue, i.e. loses exactly the work the timeout is protecting.
 */
export const SUBMIT_TIMEOUT_MS = 10_000

export interface SubmitBody {
  readonly version: number
  /** Absent, not empty, when there is no note — see {@link buildBatch}. */
  readonly note?: string
  readonly batch: readonly AnnotationDraft[]
}

export type SubmitResult =
  | {
      readonly ok: true
      readonly written: number
      readonly pending: number
      readonly queuePath: string
    }
  | {
      readonly ok: false
      /** One line, for the panel footer. Already user-facing; do not wrap it further. */
      readonly reason: string
      /** Everything else, for `console.error`. Absent when the reason is the whole story. */
      readonly detail?: unknown
    }

/**
 * The request body for a batch.
 *
 * **`key` is stripped**, which is the one transformation that matters. It is a local
 * counter that never leaves the tab, and dogear-vite's `stampAnnotation` spreads client
 * fields straight through — so an unrecognised extra field rides into `queue.json` and
 * anything id-shaped there will eventually be mistaken for the server's `id`. See
 * ./queue.ts.
 *
 * An all-whitespace note is **omitted rather than sent as `""`**, so the absence of an
 * instruction is represented one way instead of two. The server treats both the same, but
 * `queue.json` is a file people read.
 */
export function buildBatch(items: readonly QueueItem[], note: string): SubmitBody {
  const trimmed = note.trim()

  return {
    version: PROTOCOL_VERSION,
    ...(trimmed === '' ? {} : { note: trimmed }),
    batch: items.map(({ key: _key, ...draft }) => draft),
  }
}

export interface SubmitRequest {
  /** Base path, e.g. `/__dogear`. `/annotations` is appended here. */
  readonly endpoint: string
  readonly body: SubmitBody
  readonly signal?: AbortSignal
}

/**
 * POST a batch and normalise every outcome into one shape.
 *
 * Four failure shapes collapse here, which is the whole point of the function: the endpoint
 * answers 400 with `{ errors: [...] }` and 4xx/5xx with `{ error: "..." }`, `fetch` rejects
 * outright when the dev server is gone, and an abort arrives as a rejection too. The panel
 * renders one line regardless.
 *
 * `credentials: 'same-origin'` is the default and is not restated; the request is
 * same-origin by construction, which is also what makes cross-repo isolation free — the dev
 * server that served the page is the one that writes. See the brief.
 */
export async function submitBatch({
  endpoint,
  body,
  signal,
}: SubmitRequest): Promise<SubmitResult> {
  let response: Response
  try {
    response = await fetch(`${endpoint}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    // An abort is indistinguishable from a network failure at the call site, and they need
    // different words: one is "your dev server is not there", the other is "it never
    // answered". Both leave the queue untouched.
    return isAbort(error)
      ? {
          ok: false,
          reason: `The dev server did not respond within ${SUBMIT_TIMEOUT_MS / 1000}s.`,
          detail: error,
        }
      : {
          ok: false,
          reason: 'Could not reach the dev server. Is it still running?',
          detail: error,
        }
  }

  // Parsed before the status is consulted: the endpoint puts its reasons in the body on
  // every path, and a 500 from something upstream of dogear may not be JSON at all.
  const payload = await readJson(response)

  if (!response.ok) {
    return {
      ok: false,
      reason: reasonFrom(payload) ?? `The dev server answered ${response.status}.`,
      detail: payload ?? response.status,
    }
  }

  const result = asRecord(payload)
  if (result === undefined || result.ok !== true) {
    // A 200 that is not the shape we asked for. Treated as a failure so the queue is kept:
    // clearing the only copy of the user's work on anything less than a confirmed write is
    // the one mistake this ticket exists to not make.
    return {
      ok: false,
      reason: 'The dev server answered with something dogear did not understand.',
      detail: payload,
    }
  }

  return {
    ok: true,
    written: asNumber(result.written) ?? body.batch.length,
    pending: asNumber(result.pending) ?? 0,
    queuePath: asString(result.queuePath) ?? '.dogear/queue.json',
  }
}

/** `null` for a body that is absent or not JSON — a proxy's HTML error page, say. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/** The endpoint's two error shapes: `errors: string[]` on 400, `error: string` elsewhere. */
function reasonFrom(payload: unknown): string | undefined {
  const body = asRecord(payload)
  if (body === undefined) return undefined

  if (Array.isArray(body.errors)) {
    const errors = body.errors.filter(
      (entry): entry is string => typeof entry === 'string',
    )
    if (errors.length > 0) return errors.join('; ')
  }

  return asString(body.error)
}

/**
 * `AbortError` by name rather than `instanceof DOMException`.
 *
 * `signal.reason` is a `DOMException` in a browser and in happy-dom, but the constructor is
 * not reliably a global everywhere core's node-environment tests run — and the name is the
 * part the spec pins.
 */
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
