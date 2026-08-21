import type { AnnotationInput } from 'dogear-queue'

/**
 * Validation for the `POST <endpoint>/annotations` request body.
 *
 * Split out of ./annotation.ts when D1 moved annotation identity and lifecycle into
 * `dogear-queue`. This half stayed behind deliberately: it describes the shape of an HTTP
 * request, which is the *plugin's* wire contract — mirrored by `dogear-core`'s `submit.ts`
 * on the sending side — and has nothing to say about the queue file. The MCP server links
 * against `dogear-queue` and has no HTTP surface at all; giving it one by association is
 * the kind of layering mistake that stays invisible until someone tries to reuse it.
 */

export type Validation =
  | {
      readonly ok: true
      readonly batch: readonly AnnotationInput[]
      /** The batch-wide note, absent when there was none or it was only whitespace. */
      readonly note: string | undefined
    }
  | { readonly ok: false; readonly errors: readonly string[] }

/** The only version of the POST contract that exists. */
export const PROTOCOL_VERSION = 1

/**
 * Validate a decoded request body.
 *
 * Deliberately shallow: the envelope, plus `comment` being a non-empty string. The comment
 * is the whole reason an annotation exists — an item without one reaches the agent as
 * noise — but everything else in the brief's annotation shape is produced by the C epic,
 * and validating fields nothing emits yet would reject the very payloads this milestone is
 * built to accept.
 *
 * Every problem is collected rather than only the first, so a caller fixing a hand-written
 * `curl` batch learns everything wrong with it in one round trip.
 */
export function validateBatch(body: unknown): Validation {
  const errors: string[] = []

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a JSON object'] }
  }

  const {
    version,
    batch,
    note: rawNote,
  } = body as { version?: unknown; batch?: unknown; note?: unknown }

  if (version !== PROTOCOL_VERSION) {
    errors.push(
      `version must be ${PROTOCOL_VERSION}, received ${JSON.stringify(version)}`,
    )
  }

  // Optional, but a *present* note must be a string. Rejecting rather than coercing, for
  // the same reason the comment check is strict: the note is stamped onto every item in the
  // batch, so `String(someObject)` would write "[object Object]" onto all of them and the
  // client would have no way to know it had happened.
  if (rawNote !== undefined && typeof rawNote !== 'string') {
    errors.push(`note must be a string when present, received ${JSON.stringify(rawNote)}`)
  }

  if (!Array.isArray(batch)) {
    errors.push('batch must be an array')
    return { ok: false, errors }
  }

  batch.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`batch[${index}] must be an object`)
      return
    }

    const { comment } = item as { comment?: unknown }
    if (typeof comment !== 'string' || comment.trim() === '') {
      errors.push(`batch[${index}].comment must be a non-empty string`)
    }
  })

  if (errors.length > 0) return { ok: false, errors }

  // Whitespace-only reads as absent. The client already omits an empty note, so this is for
  // a hand-written `curl` batch — and one representation of "no instruction" in the queue
  // file is worth more than faithfully recording that someone typed three spaces.
  const trimmed = typeof rawNote === 'string' ? rawNote.trim() : ''

  return {
    ok: true,
    batch: batch as readonly AnnotationInput[],
    note: trimmed === '' ? undefined : trimmed,
  }
}
