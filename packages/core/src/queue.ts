/**
 * B3 (#10) — the in-memory batch.
 *
 * Comments accumulate here so you can leave eight of them across three pages before anything
 * is written. **Nothing in this file touches the network or the disk** — B5 (#12) drains it
 * into a POST, and until then the tab holds the only copy.
 *
 * Pure data with no DOM, which is why it lives apart from the session that drives it: it
 * tests in the node environment with no happy-dom docblock, and B4 (#11) — which adds edit
 * and delete — has one obvious file to work in rather than a closure variable inside a
 * 400-line state machine.
 */

import type { ElementDescription } from './describe.js'

/**
 * The brief's `viewport` shape — `w`/`h`/`dpr`, not `width`/`height`.
 *
 * Deliberately *not* the `Viewport` in ./box.ts, which is `{ width, height }` for anchoring
 * arithmetic. One is a wire field and one is a measurement; giving them the same name would
 * invite passing either where the other belongs, and TypeScript would not object because both
 * are bags of numbers.
 */
export interface QueuedViewport {
  readonly w: number
  readonly h: number
  readonly dpr: number
}

/**
 * An annotation as the browser assembles it.
 *
 * **A draft, because four of the brief's Annotation fields are not ours to write.**
 * `@dogear/vite`'s `stampAnnotation()` sets `id` (a UUIDv7), `status`, `createdAt` and
 * `resolvedAt` over whatever the client sends, client-fields-first, so a batch cannot write
 * itself into the queue pre-resolved. Generating an `id` here would produce a v4 that the
 * server discards — or worse, one that survives into `queue.json` and breaks the
 * time-sortability v7 was chosen for.
 *
 * The rest of the holes are named tickets, not oversights: `sites` is C1/C2 (#15, #16),
 * `origin` and `app` are C4 (#18), and `element`'s `selector` and `testId` are C3 (#17) —
 * see ./describe.ts for why the description is deliberately a subset rather than a
 * throwaway full payload.
 */
export interface AnnotationDraft {
  /** Trimmed and non-empty. The server rejects the whole batch otherwise — see `validateBatch`. */
  readonly comment: string
  readonly element: ElementDescription
  readonly url: string
  readonly viewport: QueuedViewport
  /**
   * When the comment was **typed**, ISO-8601.
   *
   * Named apart from `createdAt` on purpose. The server stamps `createdAt` at submit time, so
   * with batching every item in a batch would carry the moment you pressed submit rather than
   * the moment you wrote it — and this is the only point at which the real time exists.
   * Whether it is sent as `createdAt` (which needs `stampAnnotation`'s spread amended) or
   * under its own key is B5's (#12) call; recording it costs one field and keeps both open.
   */
  readonly authoredAt: string
}

/** A draft, plus the handle B4 (#11) edits and deletes by. */
export interface QueueItem extends AnnotationDraft {
  /**
   * Local-only, and stripped before the POST.
   *
   * A counter rather than a UUID for two reasons. It never leaves the tab, so uniqueness
   * within one session is all it has to promise. And anything UUID-shaped on an annotation
   * will eventually be mistaken for the server's `id` and sent — `stampAnnotation` spreads
   * client fields through, so an unrecognised extra field rides straight into `queue.json`.
   *
   * B4 addresses items by this rather than by array index, so deleting item 1 cannot silently
   * re-point a handler bound to item 2.
   */
  readonly key: number
}

export interface Queue {
  readonly count: number
  /** Oldest first, matching the queue file's ordering. */
  readonly items: readonly QueueItem[]
  /** Append a draft. Returns the stored item, so the caller has its key without a re-read. */
  add(draft: AnnotationDraft): QueueItem
}

export function createQueue(): Queue {
  const items: QueueItem[] = []
  let nextKey = 1

  return {
    get count() {
      return items.length
    },

    get items() {
      // A copy. The session hands this to the badge and, from B4, to a render pass; handing
      // out the live array would let a consumer splice the queue by accident, and the only
      // copy of the user's work is the one thing in dogear that cannot be recovered.
      return [...items]
    },

    add(draft) {
      const item: QueueItem = { ...draft, key: nextKey++ }
      items.push(item)
      return item
    },
  }
}
