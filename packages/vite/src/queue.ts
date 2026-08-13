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
 * **Two Vite processes in one repo append to one file.** A monorepo with three dev servers
 * has three writers and a single queue, by design — one repo is one agent session. That
 * produces two rules, and violating either loses a user's annotations silently, which is
 * the worst failure mode available to us.
 *
 * 1. **Read-modify-write on every submit.** Re-read immediately before writing. Never hold
 *    queue state between calls and never cache at server start: another process may have
 *    written since, and writing a remembered array would erase whatever it added.
 * 2. **The temp filename contains the pid.** Two processes serializing at once to a shared
 *    `queue.json.tmp` would interleave their bytes, and the survivor of the race would
 *    `rename()` a corrupted file into place.
 *
 * This does not make concurrent writes *safe* — two processes can still interleave between
 * the read and the rename, and the later writer wins. What these rules buy is that the
 * failure is a lost append rather than a corrupted queue, and that nothing here has to be
 * undone to fix it properly.
 *
 * **C4 (#18) deliberately left that window open**, having weighed it: `appendToQueue` is
 * synchronous end to end, so no interleave is possible *within* a process, and across two
 * processes the window is the few milliseconds of `fs` work between the read and the rename
 * — reachable only by two humans submitting at the same instant in one repo. Closing it
 * needs a lock file with stale-lock recovery, which a dev server that can be SIGKILLed makes
 * into real machinery, and which D1's MCP server would inherit. It is in the brief's
 * "Still open"; revisit it when someone actually loses an annotation.
 *
 * D1's MCP server needs all of this to resolve and prune. When it lands, move this file
 * rather than writing a second copy — a divergent implementation of the two rules above is
 * exactly the bug nobody would find.
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

export interface AppendResult {
  readonly written: number
  readonly pending: number
}

/** `<gitRoot>/.dogear/queue.json`. */
export function queuePathFor(gitRoot: string): string {
  return join(gitRoot, QUEUE_DIR, 'queue.json')
}

/**
 * The scratch file a write serializes into before renaming it into place.
 *
 * The pid is the whole point: two dev servers in one repo writing to a shared
 * `queue.json.tmp` would interleave their bytes, and whichever won the `rename()` race
 * would move a corrupted file into place. It stays in the same directory as its target,
 * because `rename()` is only atomic within a filesystem.
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
 * is a queue whose contents we cannot safely preserve. The caller turns that into a 500 and
 * leaves the bytes alone, because they may be hand-recoverable and they may be the only
 * copy of work the user has not resolved yet.
 */
export function readQueue(queuePath: string): Queue {
  if (!existsSync(queuePath)) {
    return { version: QUEUE_VERSION, updatedAt: null, items: [] }
  }

  const raw = readFileSync(queuePath, 'utf8')

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
 * Append annotations and write the result atomically.
 *
 * The write is serialize → `queue.json.<pid>.tmp` → `rename()`. A reader therefore observes
 * either the old file or the new one, never a half-written one — `rename()` within a
 * directory is atomic, which is the entire reason for the temp file. Writing `queue.json`
 * in place would leave a truncated file visible for as long as the write takes, and the
 * reader on the other end is an agent that will happily act on nonsense.
 */
export function appendToQueue(
  queuePath: string,
  annotations: readonly Annotation[],
  now = new Date(),
): AppendResult {
  mkdirSync(dirname(queuePath), { recursive: true })

  // Re-read HERE, immediately before the write, and never earlier. See the header.
  const current = readQueue(queuePath)
  const items = [...current.items, ...annotations]

  const next: Queue = {
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

  return {
    written: annotations.length,
    pending: items.filter((item) => item.status === 'pending').length,
  }
}
