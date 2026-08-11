import { randomBytes } from 'node:crypto'

/**
 * Annotation identity, stamping, and request validation.
 *
 * The division of labour is the brief's: the browser describes *what it saw*, and the
 * server owns *identity and lifecycle*. A client cannot supply its own `id`, `createdAt`,
 * `status` or `resolvedAt` — those are overwritten unconditionally. Two reasons. Only the
 * server can guarantee the queue file reads chronologically, which is the entire argument
 * for a time-sortable id. And a client that could choose its own id could collide with, or
 * impersonate, an item written by a different dev server in the same repo.
 */

/** Everything the client sends, plus the four fields the server owns. */
export interface Annotation {
  readonly id: string
  readonly status: 'pending' | 'resolved' | 'stale'
  readonly comment: string
  readonly createdAt: string
  readonly resolvedAt: string | null
  readonly [key: string]: unknown
}

/** A batch item as received: a comment, plus whatever else the epic that sent it knows. */
export interface AnnotationInput {
  readonly comment: string
  readonly [key: string]: unknown
}

export type Validation =
  | { readonly ok: true; readonly batch: readonly AnnotationInput[] }
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

  const { version, batch } = body as { version?: unknown; batch?: unknown }

  if (version !== PROTOCOL_VERSION) {
    errors.push(
      `version must be ${PROTOCOL_VERSION}, received ${JSON.stringify(version)}`,
    )
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

  return { ok: true, batch: batch as readonly AnnotationInput[] }
}

/**
 * Stamp server-owned fields over a validated input.
 *
 * The spread order matters: client fields first, server fields second, so a batch that
 * arrives carrying `"status": "resolved"` cannot write itself into the queue pre-resolved.
 */
export function stampAnnotation(input: AnnotationInput, now = new Date()): Annotation {
  return {
    ...input,
    id: uuidv7(now.getTime()),
    status: 'pending',
    createdAt: now.toISOString(),
    resolvedAt: null,
  }
}

/**
 * Build a UUIDv7 generator with its own monotonic state.
 *
 * A UUIDv7 (RFC 9562) is a 48-bit big-endian Unix millisecond timestamp, then version and
 * variant bits, then randomness. Lexicographic order matches chronological order, so the
 * queue reads oldest-first without anyone sorting it.
 *
 * Node ships `randomUUID()` but that is v4 — random throughout, and therefore useless for
 * ordering. Hand-rolling v7 is about fifteen lines and avoids a dependency for it.
 *
 * `rand_a` (the 12 bits after the version nibble) carries a monotonic counter rather than
 * randomness, which RFC 9562 explicitly allows. Without it, every annotation in one
 * submitted batch shares a millisecond and their relative order would be random — the file
 * would still be chronological between batches but shuffled within one, which is precisely
 * the case a user is most likely to notice.
 *
 * The state is per-generator rather than module-global so that a caller passing an explicit
 * `now` gets what it asked for. A shared counter cannot be rewound — that is the whole
 * point of it — so a module-global would silently ignore any timestamp earlier than the
 * last one issued, which makes deterministic testing impossible and makes a test that
 * *looks* like it is checking timestamp encoding actually check nothing.
 */
export function createUuidv7(): (now?: number) => string {
  let lastMs = -1
  let sequence = 0

  return function uuidv7(now = Date.now()): string {
    if (now > lastMs) {
      lastMs = now
      sequence = 0
    } else {
      // Same millisecond, or the clock went backwards (NTP correction, a VM resuming).
      // Either way, keep issuing ids after the ones already handed out rather than risking
      // a duplicate — `lastMs` is deliberately not rewound.
      sequence += 1
    }

    // 12 bits exhausted. Borrowing from the next millisecond keeps ids monotonic; the
    // alternative is blocking, and nothing here is worth a spin loop. Checked after both
    // branches, because a sequence above 0xfff would overflow into the version nibble
    // below and produce something that is not a UUIDv7 at all.
    if (sequence > 0xfff) {
      lastMs += 1
      sequence = 0
    }

    const bytes = randomBytes(16)
    bytes.writeUIntBE(lastMs, 0, 6)
    bytes.writeUInt8(0x70 | (sequence >>> 8), 6)
    bytes.writeUInt8(sequence & 0xff, 7)
    bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)

    const hex = bytes.toString('hex')
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-')
  }
}

/**
 * The process-wide generator, which is what `stampAnnotation` uses. One per process is
 * correct: it only has to order the ids this process mints, and ids from another dev server
 * are ordered against these by their timestamp.
 */
export const uuidv7 = createUuidv7()
