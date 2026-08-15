import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { QUEUE_DIR } from '@dogear/queue'

import type { Step } from './scaffold.js'

/**
 * `.dogear/` exists **and is a directory**.
 *
 * E1's only step, and the smallest one that is genuinely load-bearing: every later step
 * and every queue write puts a file inside this directory. `QUEUE_DIR` comes from
 * `@dogear/queue` rather than a second `'.dogear'` literal here — that constant is what
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
