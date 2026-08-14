import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { Annotation } from './annotation.js'

/**
 * Reading and writing `<git-root>/.dogear/queue.json`.
 *
 * This is the most concurrency-sensitive code in dogear, and the reasoning behind it is the
 * brief's, restated here because the next person to touch it will read this file rather
 * than the brief:
 *
 * **Several processes in one repo append to one file.** A monorepo with three dev servers
 * has three writers and a single queue, by design — one repo is one agent session. Since D1
 * there is a fourth: the MCP server resolves and prunes while you are still clicking. That
 * produces two rules, and violating either loses a user's annotations silently, which is the
 * worst failure mode available to us.
 *
 * 1. **Read-modify-write on every mutation.** Re-read immediately before writing. Never hold
 *    queue state between calls and never cache at server start: another process may have
 *    written since, and writing a remembered array would erase whatever it added. Every
 *    writer below re-reads inside itself, and `writeQueue` deliberately does not read at all
 *    so that no caller can be tempted to hoist it.
 * 2. **The temp filename contains the pid.** Two processes serializing at once to a shared
 *    `queue.json.tmp` would interleave their bytes, and the survivor of the race would
 *    `rename()` a corrupted file into place.
 *
 * This does not make concurrent writes *safe* — two processes can still interleave between
 * the read and the rename, and the later writer wins. What these rules buy is that the
 * failure is a lost append rather than a corrupted queue, and that nothing here has to be
 * undone to fix it properly.
 *
 * **C4 (#18) deliberately left that window open**, having weighed it: each writer is
 * synchronous end to end, so no interleave is possible *within* a process, and across
 * processes the window is the few milliseconds of `fs` work between the read and the rename.
 * Closing it needs a lock file with stale-lock recovery, which a dev server that can be
 * SIGKILLed makes into real machinery. It is in the brief's "Still open"; D1 inherited the
 * window knowingly rather than closing it. Revisit when someone actually loses an annotation.
 *
 * ---
 *
 * **Two readers, and the rule that governs which to use: reads may tolerate, writes must
 * refuse.**
 *
 * - {@link readQueue} is strict and throws. Every **writer** uses it, without exception.
 * - {@link tryReadQueue} is tolerant and never throws. Only **read-only** callers may use it.
 *
 * The asymmetry is not stylistic. `tryReadQueue` *drops* entries that are not
 * annotation-shaped, so writing back what it returned would silently delete a hand-broken
 * item — the caller would see a successful resolve and the user would lose an annotation
 * they could previously still read in the file. `readQueue` refuses the whole file instead,
 * which is the correct answer when the next step is to overwrite it.
 *
 * Before D1 these lived in two packages and the split was enforced by a parity test. Now
 * they are two exports of one module and the rule is written down; ./tolerance.test.ts
 * checks that they agree on healthy files and diverge only on corrupt ones.
 */

/** The directory holding dogear's per-repo state. Committed config, gitignored queue. */
export const QUEUE_DIR = '.dogear'

/** The only queue schema version that exists. */
export const QUEUE_VERSION = 1

export interface Queue {
  readonly version: number
  /** `null` only for a queue that has never been written. */
  readonly updatedAt: string | null
  readonly items: readonly Annotation[]
}

/**
 * An annotation as read back off disk.
 *
 * `status` is `string`, not {@link Annotation}'s `'pending' | 'resolved'` union, and that is
 * deliberate: this describes a file a human may have hand-written, so the type has to say
 * what could actually be in it rather than what a well-behaved writer produces. The index
 * signature carries whatever the C epic added by the time the file was written — `sites`,
 * `element`, `app`, `origin`, `note` — all of which the formatter renders only when present.
 *
 * {@link Annotation} is assignable to this, which is why the writers below accept it and
 * both readers can feed them.
 */
export interface StoredAnnotation {
  readonly id: string
  readonly status: string
  readonly comment: string
  readonly [key: string]: unknown
}

/**
 * Either the items, or why there are none.
 *
 * A `reason` is for a developer, never for the model — a caller must not put it on stdout,
 * which `UserPromptSubmit` injects verbatim as context.
 */
export type QueueRead =
  | { readonly ok: true; readonly items: readonly StoredAnnotation[] }
  | { readonly ok: false; readonly reason: string }

export interface AppendResult {
  readonly written: number
  readonly pending: number
}

export interface ResolveResult {
  /**
   * How many items this call actually changed from `pending` to `resolved` — **not** how
   * many ids were asked for. An id that is unknown, duplicated, or already resolved
   * contributes nothing, which is what makes D2's "a resolve of an unknown id is a no-op"
   * observable to the caller rather than merely true.
   */
  readonly resolved: number
  /** Pending items left in the queue after the write. */
  readonly remaining: number
}

export interface PruneResult {
  readonly pruned: number
  /** Pending items left in the queue after the write. */
  readonly remaining: number
}

/** `<gitRoot>/.dogear/queue.json`. */
export function queuePathFor(gitRoot: string): string {
  return join(gitRoot, QUEUE_DIR, 'queue.json')
}

/**
 * The scratch file a write serializes into before renaming it into place.
 *
 * The pid is the whole point: two writers in one repo using a shared `queue.json.tmp` would
 * interleave their bytes, and whichever won the `rename()` race would move a corrupted file
 * into place. It stays in the same directory as its target, because `rename()` is only
 * atomic within a filesystem.
 */
export function tempPathFor(queuePath: string): string {
  return `${queuePath}.${process.pid}.tmp`
}

/**
 * Read the queue, treating "no file yet" as an empty queue rather than an error — the first
 * annotation in a repo is the common case, not an exceptional one.
 *
 * Everything else throws. A file that exists but does not parse, or parses to the wrong
 * shape, or announces a schema version this build does not know, is not an empty queue: it
 * is a queue whose contents we cannot safely preserve. The plugin turns that into a 500 and
 * leaves the bytes alone, because they may be hand-recoverable and they may be the only copy
 * of work the user has not resolved yet; the MCP server turns it into a tool error.
 *
 * **This is the reader every writer must use.** See the header.
 */
export function readQueue(queuePath: string): Queue {
  if (!existsSync(queuePath)) {
    return { version: QUEUE_VERSION, updatedAt: null, items: [] }
  }

  let raw: string
  try {
    raw = readFileSync(queuePath, 'utf8')
  } catch (cause) {
    // Every message this function throws names the path, because `tryReadQueue` surfaces
    // them verbatim as its `reason` and a reason without a path is not actionable.
    throw new Error(`${queuePath} could not be read: ${messageOf(cause)}`, { cause })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`${queuePath} exists but is not valid JSON`, { cause })
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${queuePath} is not a queue object`)
  }

  const queue = parsed as { version?: unknown; updatedAt?: unknown; items?: unknown }

  if (queue.version !== QUEUE_VERSION) {
    throw new Error(
      `${queuePath} declares schema version ${JSON.stringify(queue.version)}, but this ` +
        `build only understands ${QUEUE_VERSION}. Refusing to overwrite it.`,
    )
  }

  if (!Array.isArray(queue.items)) {
    throw new Error(`${queuePath} has no items array`)
  }

  return {
    version: QUEUE_VERSION,
    updatedAt: typeof queue.updatedAt === 'string' ? queue.updatedAt : null,
    items: queue.items as readonly Annotation[],
  }
}

/**
 * Read the queue, degrading to a reason rather than throwing.
 *
 * Built on {@link readQueue} rather than beside it, so the two can never disagree about the
 * envelope. What it adds is the two tolerances a read-only caller wants and a writer must
 * not have:
 *
 * - **It never throws.** `dogear hook` runs on every prompt the user types, and an unhandled
 *   error there is a crash report attached to someone's unrelated question. Worse,
 *   `UserPromptSubmit` treats exit code 2 as "block and erase the prompt", so a hook that
 *   dies loudly can destroy input the user typed. Every failure degrades to "no context this
 *   turn".
 * - **Entries that are not annotation-shaped are dropped individually** rather than failing
 *   the whole read. One malformed entry in a hand-edited file should cost that entry, not
 *   the other nine.
 *
 * That second tolerance is exactly why **the result of this function must never be written
 * back.** Doing so would delete the dropped entries. See the header.
 */
export function tryReadQueue(queuePath: string): QueueRead {
  try {
    return { ok: true, items: readQueue(queuePath).items.filter(isAnnotation) }
  } catch (error) {
    return { ok: false, reason: messageOf(error) }
  }
}

/**
 * Pending items only.
 *
 * `status` is compared exactly. An item with no status, or a status this build does not
 * recognise, is not pending — the strict direction is the safe one, since the failure it
 * produces is a missing item the user can see in the file rather than a resolved item
 * silently resurfacing.
 */
export function pendingOnly<T extends { readonly status: string }>(
  items: readonly T[],
): readonly T[] {
  return items.filter((item) => item.status === 'pending')
}

/**
 * Items belonging to one workspace package.
 *
 * Matched exactly, and an item carrying no `app` at all is excluded rather than included —
 * the brief's wording is "filtered to one workspace package", singular, and an annotation
 * that never recorded which app it came from cannot be claimed by one. Items predating C4
 * have no `app`, so this is not a hypothetical.
 */
export function withApp<T extends { readonly [key: string]: unknown }>(
  items: readonly T[],
  app: string,
): readonly T[] {
  return items.filter((item) => item['app'] === app)
}

/**
 * Serialize and put the queue in place atomically.
 *
 * serialize → `queue.json.<pid>.tmp` → `rename()`. A reader therefore observes either the
 * old file or the new one, never a half-written one — `rename()` within a directory is
 * atomic, which is the entire reason for the temp file. Writing `queue.json` in place would
 * leave a truncated file visible for as long as the write takes, and the reader on the other
 * end is an agent that will happily act on nonsense.
 *
 * **This function does not read.** Its callers re-read immediately before calling it, and
 * keeping the read out of here is what makes that rule checkable at each call site instead
 * of buried one level down.
 */
export function writeQueue(
  queuePath: string,
  items: readonly StoredAnnotation[],
  now = new Date(),
): void {
  mkdirSync(dirname(queuePath), { recursive: true })

  // Not annotated as `Queue`: that type describes what a *reader* gets back, whose `items`
  // are the strict `Annotation`. Serializing is the one place the loose type is correct,
  // and a cast here would be asserting something this function has no way to know.
  const next = {
    version: QUEUE_VERSION,
    updatedAt: now.toISOString(),
    items,
  }

  const tempPath = tempPathFor(queuePath)
  try {
    // Trailing newline because `cat .dogear/queue.json` is a stated design goal.
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tempPath, queuePath)
  } catch (error) {
    // A temp file left behind would be picked up by nothing and confuse the next person to
    // look in .dogear/. It is gitignored, but that is not a reason to litter.
    rmSync(tempPath, { force: true })
    throw error
  }
}

/** Append annotations and write the result atomically. */
export function appendToQueue(
  queuePath: string,
  annotations: readonly Annotation[],
  now = new Date(),
): AppendResult {
  // Re-read HERE, immediately before the write, and never earlier. See the header.
  const current = readQueue(queuePath)
  const items = [...current.items, ...annotations]

  writeQueue(queuePath, items, now)

  return { written: annotations.length, pending: pendingOnly(items).length }
}

/**
 * Mark annotations resolved by id — D2's "a tool call cannot corrupt the queue".
 *
 * Three properties worth stating, each of which has a test:
 *
 * 1. **Unknown ids are a no-op, not an error.** An agent re-reading a stale transcript will
 *    resolve ids that are already gone; erroring there would make it think something is
 *    broken and retry.
 * 2. **Nothing is written when nothing changed.** Not a fresh `updatedAt`, not a rename, and
 *    not a `.dogear/` directory in a repo that has never used dogear. A no-op that still
 *    rewrites the file is a no-op that can still lose a concurrent append.
 * 3. **Untouched items pass through by spread, never reconstructed.** Every unknown field on
 *    every item the call did not match survives exactly as it was read, which is what makes
 *    this safe against a queue containing fields this build has never heard of.
 */
export function resolveInQueue(
  queuePath: string,
  ids: readonly string[],
  now = new Date(),
): ResolveResult {
  // Re-read HERE, immediately before the write, and never earlier. See the header.
  const current = readQueue(queuePath)

  const wanted = new Set(ids)
  let resolved = 0

  const items = current.items.map((item) => {
    // Only `pending` flips. Re-resolving an already-resolved item would rewrite its
    // `resolvedAt` to now, quietly falsifying when the work was actually done.
    if (!wanted.has(item.id) || item.status !== 'pending') return item

    resolved += 1
    return { ...item, status: 'resolved' as const, resolvedAt: now.toISOString() }
  })

  if (resolved > 0) writeQueue(queuePath, items, now)

  return { resolved, remaining: pendingOnly(items).length }
}

/**
 * Drop resolved items — the explicit counterweight to append-with-status.
 *
 * Removes only `status === 'resolved'`, so an unknown status survives. That is the same
 * strict direction {@link pendingOnly} takes, resolved the same way: the safe failure is an
 * item that outlives a prune, not one that vanishes from a file the user thought was
 * history. Nothing here is ever automatic — no TTL, no background sweep.
 */
export function pruneQueue(queuePath: string, now = new Date()): PruneResult {
  // Re-read HERE, immediately before the write, and never earlier. See the header.
  const current = readQueue(queuePath)

  const items = current.items.filter((item) => item.status !== 'resolved')
  const pruned = current.items.length - items.length

  if (pruned > 0) writeQueue(queuePath, items, now)

  return { pruned, remaining: pendingOnly(items).length }
}

function isAnnotation(value: unknown): value is StoredAnnotation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const { id, status, comment } = value as Record<string, unknown>
  return (
    typeof id === 'string' && typeof status === 'string' && typeof comment === 'string'
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
