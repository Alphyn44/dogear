import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reading `<git-root>/.dogear/queue.json` from the agent side.
 *
 * This is a **read-only, tolerant** counterpart to `packages/vite/src/queue.ts`, and the
 * tolerance is the entire reason it is a separate function rather than an import. The two
 * callers want opposite things from a broken queue:
 *
 * - The **plugin** throws. A file that exists but does not parse is not an empty queue, it
 *   is a queue whose contents cannot be safely preserved — so the endpoint answers 500 and
 *   leaves the bytes alone, because they may be the only copy of work the user has not
 *   resolved yet.
 * - The **hook** must never throw, and must never exit non-zero. It runs on every single
 *   prompt the user types, and an unhandled error there is a crash report attached to
 *   someone's unrelated question. Worse, `UserPromptSubmit` treats exit code 2 as "block
 *   and erase the prompt" — so a hook that dies loudly can destroy input the user typed.
 *   Every failure here degrades to "no context this turn".
 *
 * Both files still have to agree on *where* the queue is and *what shape* it has, and
 * ./parity.test.ts enforces that against the vite copy directly.
 *
 * Nothing here writes. D2's resolve and D6's prune arrive through the MCP server, which
 * lives in this package too and will need the read-modify-write half — at which point this
 * file grows a writer and the vite copy folds into it.
 */

/** The directory holding dogear's per-repo state. Committed config, gitignored queue. */
export const QUEUE_DIR = '.dogear'

/** The only queue schema version that exists. */
export const QUEUE_VERSION = 1

/**
 * An annotation as read back off disk.
 *
 * `status` is `string`, not the writer's `'pending' | 'resolved'` union, and that is
 * deliberate: this parses a file a human may have hand-written, so the type has to describe
 * what could actually be in it rather than what a well-behaved writer produces. The index
 * signature carries whatever the C epic has added by the time the file was written —
 * `source`, `app`, `origin`, `element` — none of which exist yet, and all of which the
 * formatter renders only when present.
 */
export interface Annotation {
  readonly id: string
  readonly status: string
  readonly comment: string
  readonly [key: string]: unknown
}

/**
 * Either the items, or why there are none.
 *
 * A `reason` is for the developer's stderr, never for the model — the caller must not put
 * it on stdout, which `UserPromptSubmit` injects verbatim as context.
 */
export type QueueRead =
  | { readonly ok: true; readonly items: readonly Annotation[] }
  | { readonly ok: false; readonly reason: string }

/** `<gitRoot>/.dogear/queue.json`. */
export function queuePathFor(gitRoot: string): string {
  return join(gitRoot, QUEUE_DIR, 'queue.json')
}

/**
 * Read the queue, degrading to a reason rather than throwing.
 *
 * A **missing** file is `ok` with no items, not a failure: a repo that has never had an
 * annotation is the overwhelmingly common case, and reporting it would put a diagnostic on
 * stderr for every prompt typed in every repo that has the hook installed but has never
 * used dogear.
 *
 * Everything else — unparseable, not an object, no `items` array, a schema version this
 * build does not understand — is a failure with a reason, because in each of those cases a
 * file *is* there and the user is entitled to know why it produced nothing.
 *
 * Entries inside `items` that are not annotation-shaped are dropped individually rather
 * than failing the whole read. One malformed entry in a hand-edited file should cost that
 * entry, not the other nine.
 */
export function readQueue(queuePath: string): QueueRead {
  if (!existsSync(queuePath)) return { ok: true, items: [] }

  let raw: string
  try {
    raw = readFileSync(queuePath, 'utf8')
  } catch (error) {
    return { ok: false, reason: `${queuePath} could not be read: ${messageOf(error)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      reason: `${queuePath} is not valid JSON: ${messageOf(error)}`,
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${queuePath} is not a queue object` }
  }

  const queue = parsed as { version?: unknown; items?: unknown }

  if (queue.version !== QUEUE_VERSION) {
    return {
      ok: false,
      reason:
        `${queuePath} declares schema version ${JSON.stringify(queue.version)}, but this ` +
        `build only understands ${QUEUE_VERSION}`,
    }
  }

  if (!Array.isArray(queue.items)) {
    return { ok: false, reason: `${queuePath} has no items array` }
  }

  return { ok: true, items: queue.items.filter(isAnnotation) }
}

/**
 * Pending items only.
 *
 * `status` is compared exactly. An item with no status, or a status this build does not
 * recognise, is not pending — the strict direction is the safe one, since the failure it
 * produces is a missing item the user can see in the file rather than a resolved item
 * silently resurfacing.
 */
export function pendingOnly(items: readonly Annotation[]): readonly Annotation[] {
  return items.filter((item) => item.status === 'pending')
}

function isAnnotation(value: unknown): value is Annotation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const { id, status, comment } = value as Record<string, unknown>
  return (
    typeof id === 'string' && typeof status === 'string' && typeof comment === 'string'
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
