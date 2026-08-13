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
import type { SourceSite } from './sites.js'

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
 * The remaining holes are named tickets, not oversights: `origin` and `app` are C4 (#18),
 * and `element`'s `selector` and `testId` are C3 (#17) — see ./describe.ts for why the
 * description is deliberately a subset rather than a throwaway full payload.
 */
export interface AnnotationDraft {
  /** Trimmed and non-empty. The server rejects the whole batch otherwise — see `validateBatch`. */
  readonly comment: string
  /**
   * C2's (#16) ancestor chain — nearest-first, deduplicated by file, capped at 5.
   *
   * **Always present, empty when nothing resolved.** A third-party component, a portal, a
   * `.js` file or a project with the transform off all produce `[]`, and that is an ordinary
   * outcome rather than a failure: C3's (#17) floor is what keeps such an item useful, which
   * is the sense of its "`sites` may be empty; `element` never is". Present-and-empty rather
   * than omitted so every item in `queue.json` has one shape and D1/D5 never branch on a
   * missing key.
   */
  readonly sites: readonly SourceSite[]
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
  /** Drop an item. Returns whether the key matched anything. */
  remove(key: number): boolean
  /**
   * Replace an item's comment. Returns whether the key matched anything.
   *
   * The comment is stored as given — see {@link acceptableComment} for the rule callers
   * apply first, and why it is not enforced here.
   */
  update(key: number, comment: string): boolean
}

/**
 * A comment the server will accept, or `null`.
 *
 * The rule is @dogear/vite's `validateBatch`: a non-empty, trimmed string, or the **entire
 * batch** is rejected. Both paths that put a comment into the queue go through this — B3's
 * (#10) Enter and B4's (#11) in-place edit — so the two cannot drift into disagreeing about
 * what an empty comment means.
 *
 * A free function rather than a guard inside `add`/`update`, because the callers do not want
 * the same thing from a refusal: Enter leaves the box open and focused, an edit reverts the
 * row. A queue that silently dropped either would give both callers the same useless answer.
 */
export function acceptableComment(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
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

    remove(key) {
      const index = items.findIndex((item) => item.key === key)
      if (index === -1) return false

      items.splice(index, 1)
      return true
    },

    update(key, comment) {
      const index = items.findIndex((item) => item.key === key)
      const item = items[index]
      if (item === undefined) return false

      // Replaced rather than mutated: `QueueItem`'s fields are readonly, and a fresh object
      // means anything holding the old one — a render in flight, a half-built batch — sees a
      // consistent snapshot rather than a field changing underneath it.
      items[index] = { ...item, comment }
      return true
    },
  }
}
