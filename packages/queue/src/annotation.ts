import { randomBytes } from 'node:crypto'

/**
 * Annotation identity and lifecycle.
 *
 * The division of labour is the brief's: the browser describes *what it saw*, and the
 * server owns *identity and lifecycle*. A client cannot supply its own `id`, `createdAt`,
 * `status` or `resolvedAt` — those are overwritten unconditionally. Two reasons. Only the
 * server can guarantee the queue file reads chronologically, which is the entire argument
 * for a time-sortable id. And a client that could choose its own id could collide with, or
 * impersonate, an item written by a different dev server in the same repo.
 *
 * **Request validation is deliberately NOT here.** `validateBatch` and `PROTOCOL_VERSION`
 * describe the shape of an HTTP POST body, which is `dogear-vite`'s wire contract and is
 * mirrored by `dogear-core`'s `submit.ts` on the other side of it — they live in
 * `packages/vite/src/batch.ts`. This package is read and written by the MCP server too,
 * and the CLI has no HTTP surface at all; giving it one by association would be the kind
 * of layering mistake that is invisible until someone tries to reuse it.
 */

/** Everything the client sends, plus the four fields the server owns. */
export interface Annotation {
  readonly id: string
  /**
   * `stale` is deliberately absent. Staleness is derived at read time — an item whose text
   * snippet no longer appears in its file is still `pending`, just flagged — because a
   * stored flag goes out of date the moment someone re-adds the snippet. See the brief's
   * Decisions log.
   */
  readonly status: 'pending' | 'resolved'
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

/**
 * Stamp server-owned fields over a validated input.
 *
 * The spread order matters, and it is now four deep: client fields first, then the batch
 * note, then C4's (#18) `origin` and `app`, then the four server-owned fields. So a batch
 * that arrives carrying `"status": "resolved"` cannot write itself into the queue
 * pre-resolved, and a batch note wins over a per-item `note` the client had no business
 * sending — while still being unable to forge identity or lifecycle.
 *
 * `origin` and `app` sit on the server's side of that line deliberately. They answer "which
 * dev server, which package" — the same class of question as `id`, and answerable only by
 * the process that is actually serving. A client-supplied `origin` would also be forgeable
 * by a batch from a *different* dev server in the same repo, which is precisely the
 * ambiguity C4 exists to remove.
 *
 * The note is copied onto **every** item rather than stored once against the batch. The
 * queue file has no batch grouping, and everything downstream is per-item: D2 resolves, D5
 * flags and D6 prune one annotation at a time, so a batch-scoped record would be orphaned
 * by the first resolve. See the brief's Decisions log.
 */
export function stampAnnotation(
  input: AnnotationInput,
  { note, origin, app, now = new Date() }: StampOptions = {},
): Annotation {
  // Discarded rather than merely overwritten. A conditional spread below would let a
  // client-sent `origin` or `app` survive whenever *this* server resolved none of its own —
  // and that is precisely the case where a wrong value is least likely to be noticed, since
  // there is nothing to contradict it. The server's answer is final, including when the
  // answer is "none". Unlike `note`, which is a legitimate thing for a client to send, these
  // two describe the server itself and a client cannot know them.
  const { origin: _clientOrigin, app: _clientApp, ...client } = input

  return {
    ...client,
    ...(note === undefined ? {} : { note }),
    // Omitted rather than written as `undefined`: `queue.json` is a file people read, and
    // `JSON.stringify` would drop the key anyway — so writing it would make the in-memory
    // annotation and its serialized form disagree about which fields exist.
    ...(origin === undefined ? {} : { origin }),
    ...(app === undefined ? {} : { app }),
    id: uuidv7(now.getTime()),
    status: 'pending',
    createdAt: now.toISOString(),
    resolvedAt: null,
  }
}

/**
 * An options bag rather than positional parameters, because `now` was already the second
 * argument and B5 needed to get in front of it. Positionally that reads
 * `stampAnnotation(input, undefined, fixedDate)` at every test call site — and C4 (#18) then
 * added two more, which is the case this shape was chosen for.
 */
export interface StampOptions {
  /** Copied onto the annotation. Batch-wide; see {@link stampAnnotation}. */
  readonly note?: string
  /**
   * Which dev server this arrived at, e.g. `http://localhost:5173` — C4 (#18).
   *
   * Per-request, not per-server: one dev server answers to `localhost:5173` and
   * `127.0.0.1:5173` both, and the annotation should record the one the browser actually
   * used. Derived from the request in `packages/vite/src/endpoint.ts`.
   */
  readonly origin?: string
  /**
   * The workspace package this dev server serves, e.g. `@acme/admin` — C4 (#18).
   *
   * Per-server, and resolved once at startup — see `packages/vite/src/app-name.ts`. Absent
   * when there is no `package.json` above the Vite root or it declares no name, which is an
   * ordinary outcome rather than a failure.
   */
  readonly app?: string
  /** Injected by tests so the UUIDv7 timestamp and `createdAt` are deterministic. */
  readonly now?: Date
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
