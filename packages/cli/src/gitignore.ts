import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_FILE, QUEUE_DIR } from '@dogear/queue'

import type { GitQueries } from './git.js'
import { git } from './git.js'
import type { Plan, Step, Undo } from './scaffold.js'

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
const HEADER = '# dogear — the queue is machine state; config.json is committed'

const BLOCK = [HEADER, QUEUE_RULE, TEMP_RULE, ''].join('\n')

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
 * Take dogear's rules back out — E6 (#39).
 *
 * **The exact block or nothing, and the header comment is what makes that possible** — which is
 * what it was written for, as the note above {@link BLOCK} says. Undo looks for the three lines
 * contiguous and in the order init wrote them. A `.gitignore` whose rules have since been
 * reordered, or whose comment was deleted, is one where dogear can no longer tell its own lines
 * from lines that happen to look like them, so it removes nothing and says what to remove by
 * hand.
 *
 * **That strictness is #39's third criterion, not caution.** A `.gitignore` may perfectly well
 * have carried `.dogear/queue.json` before init ever ran — this repository's own nearly did —
 * and a line-wise sweep would delete a rule the user wrote and init merely declined to
 * duplicate. Leaving two rules behind costs a `git status` line; deleting one costs a committed
 * queue.
 *
 * **No git here, unlike the step it reverses.** `check-ignore` answers "is this path ignored",
 * which is the question init has to ask because *any* rule will do. Undo asks a narrower and
 * purely textual one — "are these three lines mine?" — and an ignore rule inherited from
 * `.git/info/exclude` is not something undo has any business removing.
 */
export const gitignoreRemoval: Undo = {
  name: 'gitignore',
  plan: (root) => {
    const path = join(root, '.gitignore')
    const existing = readIfFile(path)
    if (existing === undefined) return undefined

    // Byte-identical to what init writes into a repository that had no `.gitignore`: init
    // created the file and its rules are the whole of it.
    if (existing === BLOCK) {
      return {
        change: {
          summary: 'deleted .gitignore',
          apply: () => discard(path, BLOCK),
        },
      }
    }

    if (!written(existing)) return undefined

    if (withoutBlock(existing) === undefined) {
      return { notes: [unremovable()] }
    }

    const plan: Plan = {
      change: {
        summary: "removed dogear's rules from .gitignore",
        apply: () => {
          // Re-read rather than closing over the planned text, the same re-check the append
          // side does.
          const current = readIfFile(path)
          if (current === undefined) return

          const second = withoutBlock(current)
          if (second === undefined) return

          writeFileSync(path, second, 'utf8')
        },
      },
    }

    return plan
  },
}

/**
 * The file with dogear's block cut out, or `undefined` when it is not there intact.
 *
 * Searched as literal bytes rather than matched line by line, because "contiguous and in order"
 * is exactly what a substring search means and a line walker would be a second way of saying it.
 * Both line endings are tried: init always writes `\n`, but an editor that normalised the file
 * afterwards will have turned them into `\r\n`, and the block is still recognisably dogear's.
 *
 * One blank line above goes too, for the reason ./rules.ts's `withoutStanza` gives at length:
 * {@link separator} is lossy, and a file ending in a single newline is the case worth restoring.
 */
function withoutBlock(contents: string): string | undefined {
  for (const eol of ['\n', '\r\n']) {
    const block = [HEADER, QUEUE_RULE, TEMP_RULE, ''].join(eol)
    const at = contents.indexOf(block)
    if (at === -1) continue

    const before = contents.slice(0, at)
    const trimmed = before.endsWith(`${eol}${eol}`)
      ? before.slice(0, -eol.length)
      : before

    return `${trimmed}${contents.slice(at + block.length)}`
  }

  return undefined
}

/** Delete the file, having confirmed it is still exactly what planning saw — see ./rules.ts. */
function discard(path: string, expected: string): void {
  if (readIfFile(path) !== expected) {
    throw new Error(
      '.gitignore changed while dogear was working, so it was left alone rather than ' +
        'deleted. Re-run dogear init --undo.',
    )
  }

  rmSync(path)
}

function unremovable(): string {
  return (
    "dogear's .gitignore block has been edited, so it was left alone — its lines can no " +
    `longer be told apart from rules you wrote. Remove ${QUEUE_RULE} and ${TEMP_RULE} by hand.`
  )
}

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
