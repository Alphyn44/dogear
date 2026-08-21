import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  CONFIG_FILE,
  QUEUE_DIR,
  pendingOnly,
  queuePathFor,
  tryReadQueue,
} from 'dogear-queue'

import type { Step, Undo } from './scaffold.js'

/**
 * `.dogear/` exists **and is a directory**.
 *
 * E1's only step, and the smallest one that is genuinely load-bearing: every later step
 * and every queue write puts a file inside this directory. `QUEUE_DIR` comes from
 * `dogear-queue` rather than a second `'.dogear'` literal here — that constant is what
 * `queuePathFor` builds on, so init and the writers cannot disagree about where the
 * directory is.
 *
 * **`existsSync` alone is the bug here, not the shortcut.** It answers true for a *regular
 * file* named `.dogear`, so a step that planned on existence alone would return `undefined`
 * and init would report `nothing changed` over a repository where nothing can ever be
 * written. That is the exact failure the "already correct?" predicate exists to prevent,
 * and it is silent — no throw, exit 0, a confident report. Every step E2–E4 adds has the
 * same trap available to it: **check for the state you need, not for the path being
 * occupied.**
 *
 * `apply` re-checks rather than trusting the plan, which is what turns an opaque `EEXIST`
 * into a sentence naming the fix. `mkdirSync` stays non-recursive: the root is a git root,
 * so it exists, and there is no intermediate directory to create.
 *
 * Moved out of ./scaffold.ts by E4 (#29), unchanged. Three steps in one file was already
 * more documentation than runner, and the split gives E2 and E3 an obvious shape to copy:
 * one module, one step, the contract and the runner left alone.
 */
export const queueDirectory: Step = {
  name: 'queue-directory',
  plan: (root) => {
    const dir = join(root, QUEUE_DIR)
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true) return undefined

    return {
      change: {
        summary: `created ${QUEUE_DIR}/`,
        apply: () => {
          if (existsSync(dir)) {
            throw new Error(
              `${QUEUE_DIR} exists at ${root} but is not a directory. ` +
                'Remove it and re-run — dogear keeps its queue and config inside it.',
            )
          }

          mkdirSync(dir)
        },
      },
    }
  },
}

/**
 * `.dogear/` goes if it is empty, and **the queue never goes at all** — E6 (#39).
 *
 * The queue is the user's data, and #39 is explicit: pending annotations are reported, not
 * deleted, and removing them is a separate act. So this removes the directory and nothing in
 * it — by the time it runs, ./config.ts has taken out the only file init put there, and in the
 * ordinary case (a repository where nobody ever clicked anything) there is no `queue.json` and
 * the directory simply goes.
 *
 * ---
 *
 * **The plan/apply split is what makes this awkward, and the awkwardness is the design working.**
 * Every `plan()` runs before any `apply()`, so this one looks at a `.dogear/` that still
 * contains `config.json` — ./config.ts has planned its removal and not performed it. It
 * therefore cannot ask *"is this directory empty?"*; it asks *"will it be, once `config.json`
 * goes?"*, which is the question with `CONFIG_FILE` discounted below.
 *
 * `apply()` then asks the real question against the real directory, and throws if the answer
 * changed. That is the same re-check every `apply` in this package does, and here it is also
 * what makes the deletion safe under a race: a `queue.json` written between plan and apply
 * turns a silent data loss into a reported failure.
 */
export const queueDirRemoval: Undo = {
  name: 'queue-directory',
  plan: (root) => {
    const dir = join(root, QUEUE_DIR)
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return undefined

    let entries: readonly string[]
    try {
      entries = readdirSync(dir)
    } catch {
      // `plan()` never throws. An unreadable directory is not something undo can act on, and
      // ./config.ts's plan will already have said what it could not see.
      return undefined
    }

    // Everything ./config.ts is about to remove, discounted — see the header.
    const survivors = entries.filter((entry) => entry !== CONFIG_FILE)

    if (survivors.length > 0) return { notes: [kept(root, survivors)] }

    return {
      change: {
        summary: `deleted ${QUEUE_DIR}/`,
        // `rmdirSync` rather than a recursive `rmSync`, and that is a safety property rather
        // than a style choice: it refuses on a non-empty directory, so the worst a lost race
        // can do is fail loudly.
        apply: () => {
          const now = readdirSync(dir)

          if (now.length > 0) {
            throw new Error(
              `${QUEUE_DIR} is no longer empty at ${root} — it now holds ${now.join(', ')}. ` +
                'Nothing was deleted; remove it by hand if you meant to.',
            )
          }

          rmdirSync(dir)
        },
      },
    }
  },
}

/**
 * Why the directory is still there, in one line.
 *
 * The pending count is what the user actually needs — "3 pending annotations" is a reason to go
 * and look, and "the directory is not empty" is not — and it comes from `tryReadQueue`, the
 * tolerant reader, because `plan()` must not throw. That makes this the fourth tolerant caller,
 * after `dogear hook`, `dogear_pending` and `dogear status`.
 */
function kept(root: string, survivors: readonly string[]): string {
  const queue = basename(queuePathFor(root))

  if (!survivors.includes(queue)) {
    return (
      `${QUEUE_DIR}/ was left in place — it still holds ${survivors.join(', ')}, which ` +
      'dogear did not put there.'
    )
  }

  const read = tryReadQueue(queuePathFor(root))
  const count = read.ok ? pending(pendingOnly(read.items).length) : 'annotations'

  return (
    `${QUEUE_DIR}/${queue} has ${count} and was left in place — the queue is your data, ` +
    `not dogear's configuration. Delete ${QUEUE_DIR}/ by hand to remove it.`
  )
}

function pending(n: number): string {
  return `${n} pending annotation${n === 1 ? '' : 's'}`
}
