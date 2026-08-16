import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Plan, Step, Wiring } from './scaffold.js'

/**
 * The stanza that tells the agent to look — E3 (#28).
 *
 * **MCP is pull, and that is the whole reason this step exists.** The brief's Delivery section
 * is explicit: the agent has to decide to call the tool, so typing "go" surfaces nothing on its
 * own. Registering the server makes the queue *reachable*; this makes it *reached*. Without it
 * the baseline install is one where everything works and nothing happens, which reads to a user
 * as nothing working.
 *
 * **A genuine append, not a rewrite.** Unlike the JSON configs this step's target is markdown —
 * a line-oriented format with no enclosing syntax — so dogear's block goes on the end and every
 * byte above it is untouched. Same shape as ./gitignore.ts, down to the separator logic.
 *
 * **Delimited by HTML comments**, which is what makes the step idempotent and what E6 (#39)
 * will cut on. They render as nothing, they survive the user reformatting or reordering the
 * prose around them, and they mark an exact span — a bare `## dogear` heading would be
 * re-appended the moment someone renamed it, and gives E6 no way to find where it ends.
 */

const START = '<!-- dogear:start -->'
const END = '<!-- dogear:end -->'

/**
 * Where the stanza goes, in preference order.
 *
 * `AGENTS.md` first because it is the cross-agent convention and the file the brief names.
 * `CLAUDE.md` second because a repository that has one has already put its agent instructions
 * there, and a stanza in a file that agent does not read is a stanza that does nothing. Neither
 * present, `AGENTS.md` is created — the portable choice, and the one a second agent will also
 * find.
 */
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const

/** The block itself. Names the two tools by their MCP names, because that is what gets called. */
const STANZA = [
  START,
  '',
  '## dogear',
  '',
  'This repository uses dogear: comments left by clicking elements in the running app',
  'arrive as annotations bound to a source file and line.',
  '',
  'They come through the `dogear` MCP server, which is **pull** — nothing appears unless',
  'you ask. At the start of a task, call `dogear_pending`. When you have addressed an',
  'item, call `dogear_resolve` with its id.',
  '',
  END,
  '',
].join('\n')

export function createRulesStep(wiring: Wiring): Step {
  return {
    name: 'rules-stanza',
    plan: (root) => {
      // Nothing to nudge when nothing was wired. `--agent=none` is a user saying they will
      // handle it themselves, and a stanza pointing at an unregistered server is worse than
      // silence.
      if (wiring.agents.length === 0) return undefined

      const target = targetIn(root)
      const path = join(root, target.file)

      if (target.contents !== undefined && written(target.contents)) return undefined

      const plan: Plan = {
        change: {
          summary:
            target.contents === undefined
              ? `created ${target.file}`
              : `added dogear's stanza to ${target.file}`,
          apply: () => {
            // Re-read rather than closing over the planned contents — same reason
            // ./gitignore.ts does it: a stale copy would clobber whatever the user wrote in
            // between, and here the file is one they may well have open.
            const current = readIfFile(path)

            if (current === undefined && existsSync(path)) {
              throw new Error(
                `${target.file} exists at ${root} but is not a regular file. Remove it and ` +
                  "re-run — dogear appends its stanza to the repository's agent instructions.",
              )
            }

            if (current !== undefined && written(current)) return

            writeFileSync(path, `${current ?? ''}${separator(current)}${STANZA}`, 'utf8')
          },
        },
      }

      return plan
    },
  }
}

/** The file to append to, with what is in it — `undefined` contents means it is not there. */
function targetIn(root: string): {
  readonly file: string
  readonly contents: string | undefined
} {
  for (const file of CANDIDATES) {
    const contents = readIfFile(join(root, file))
    if (contents !== undefined) return { file, contents }
  }

  return { file: CANDIDATES[0], contents: undefined }
}

/**
 * Has dogear's stanza already been written here?
 *
 * The start marker alone is the test, matching ./gitignore.ts's reasoning: someone who deleted
 * the end marker or edited the prose between them has a stanza, and appending a second copy is
 * a worse answer than leaving their edit alone.
 */
function written(contents: string): boolean {
  return contents.includes(START)
}

/**
 * What goes between what is already there and dogear's block.
 *
 * A file not ending in a newline gets one, so the last line someone wrote is never merged with
 * the opening marker. The blank line after it is for the rendered output as much as the diff —
 * a heading immediately below a paragraph is a markdown ambiguity in some parsers.
 */
function separator(current: string | undefined): string {
  if (current === undefined || current === '') return ''
  if (current.endsWith('\n\n')) return ''
  return current.endsWith('\n') ? '\n' : '\n\n'
}

/** The file's contents, or `undefined` if it is absent or is not a regular file. */
function readIfFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}
