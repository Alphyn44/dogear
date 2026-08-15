import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_FILE, QUEUE_DIR } from '@dogear/queue'

import type { GitQueries } from './git.js'
import { git } from './git.js'
import type { Plan, Step } from './scaffold.js'

/**
 * `.gitignore` covers the queue but not the config — E4 (#29).
 *
 * The split is the whole story: `.dogear/queue.json` is machine state, pending
 * annotations that mean nothing to anyone else and change on every click, while
 * `.dogear/config.json` is a project decision that everyone who clones the repo should
 * get. Ignoring `.dogear/` wholesale is the obvious shortcut and takes the config with it.
 *
 * **`.dogear/*.tmp` is not belt-and-braces.** `writeQueue` serialises to
 * `queue.json.<pid>.tmp` and renames; the pid is what keeps two dev servers from
 * interleaving their bytes. A crash between the write and the rename leaves that file
 * behind, and without this rule it lands in `git status` looking like something the user
 * did.
 */

/** Repository-relative and forward-slashed — what git is asked, and what is written. */
const QUEUE_RULE = `${QUEUE_DIR}/queue.json`
const TEMP_RULE = `${QUEUE_DIR}/*.tmp`
const CONFIG_PATH = `${QUEUE_DIR}/${CONFIG_FILE}`

/**
 * The header is not decoration. E6 (#39) has to remove exactly what init wrote and leave
 * everything else, and two bare rules in a file a user has since reordered are not
 * identifiable. It also answers "what put this here?" for whoever reads the diff.
 */
const BLOCK = [
  '# dogear — the queue is machine state; config.json is committed',
  QUEUE_RULE,
  TEMP_RULE,
  '',
].join('\n')

/**
 * Build the step against a given view of git, so the degraded path is testable.
 *
 * The alternative was making the test break `PATH`, which is process-global state shared
 * by every other test in the worker. This seam costs one parameter and makes "git could
 * not answer" an ordinary case with an ordinary assertion — and that branch is otherwise
 * the one nobody ever runs, on the machine where it matters most.
 */
export function createGitignoreStep(queries: GitQueries): Step {
  return {
    name: 'gitignore',
    plan: (root) => {
      const path = join(root, '.gitignore')
      const existing = readIfFile(path)

      // **Ask git, do not parse `.gitignore`.** Whether the queue is ignored depends on
      // `.git/info/exclude`, on `core.excludesFile`, on every `.gitignore` between here
      // and the file, and on negation precedence. This is "check for the state you need,
      // not for the path being occupied" — the state needed is *ignored*, not *these two
      // lines are present*. See ./git.ts.
      const ignored = queries.isIgnored(root, QUEUE_RULE)

      // `undefined` — no git on PATH, a broken worktree pointer — is treated as
      // not-ignored, deliberately. The two outcomes are not symmetrical: a redundant rule
      // in `.gitignore` costs a line, and a queue that was never ignored gets committed on
      // the user's next `git add .`.
      //
      // Which is why `written()` is consulted too, and it is not a second implementation
      // of ignored-ness. It answers a narrower question — *did I already write my own
      // block?* — and it is the only thing standing between the degraded path and an init
      // that appends the same three lines on every single run.
      const needed = ignored !== true && !written(existing)

      const notes = [
        // Reported, never fixed. Appending `!.dogear/config.json` would work against a
        // `.dogear/*` rule and do nothing at all against `.dogear/` — git cannot re-include
        // a file underneath an excluded directory — so it would repair the easy case and
        // lie about the hard one. Saying so leaves the choice with whoever wrote the rule.
        ...(queries.isIgnored(root, CONFIG_PATH) === true
          ? [
              `${CONFIG_PATH} is ignored by an existing rule, so it will not be ` +
                "committed. dogear's config is meant to be shared with the repo.",
            ]
          : []),
        // The case where the acceptance criterion is met and the queue still gets
        // committed: an ignore rule has no effect on a file already in the index, which is
        // what a repo that ran a dev server before it ran `dogear init` looks like.
        ...(queries.isTracked(root, QUEUE_RULE) === true
          ? [
              `${QUEUE_RULE} is already tracked by git, so ignoring it changes nothing. ` +
                `Run \`git rm --cached ${QUEUE_RULE}\` to stop committing it.`,
            ]
          : []),
      ]

      if (!needed) return notes.length === 0 ? undefined : { notes }

      const plan: Plan = {
        change: {
          summary: existing === undefined ? 'created .gitignore' : 'updated .gitignore',
          apply: () => {
            // Re-read rather than closing over `existing`: same re-check ./queue-dir.ts
            // does, and here it is also what keeps a concurrent editor's last line from
            // being clobbered by a stale copy.
            const current = readIfFile(path)

            if (current === undefined && existsSync(path)) {
              throw new Error(
                `.gitignore exists at ${root} but is not a regular file. Remove it and ` +
                  "re-run — dogear appends its rules to the repository's own .gitignore.",
              )
            }

            writeFileSync(path, `${current ?? ''}${separator(current)}${BLOCK}`, 'utf8')
          },
        },
        notes,
      }

      return plan
    },
  }
}

/** The step init actually runs. */
export const gitignore: Step = createGitignoreStep(git)

/**
 * What goes between what is already there and dogear's block.
 *
 * A file that does not end in a newline gets one first, so the last rule someone wrote is
 * never merged with dogear's comment into a single line — which would silently disable
 * both. The blank line after it is for the human reading the diff, and is skipped when the
 * file already ends in one.
 */
function separator(current: string | undefined): string {
  if (current === undefined || current === '') return ''
  if (current.endsWith('\n\n')) return ''
  return current.endsWith('\n') ? '\n' : '\n\n'
}

/**
 * Has dogear's block already been written here?
 *
 * The queue rule alone is the test. Matching the whole block would report "not written"
 * for a file where someone deleted the comment or reordered the rules, and appending a
 * second copy is a worse answer than leaving their edit alone.
 */
function written(current: string | undefined): boolean {
  if (current === undefined) return false

  return current.split('\n').some((line) => line.trim() === QUEUE_RULE)
}

/** The file's contents, or `undefined` if it is absent or is not a regular file. */
function readIfFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}
