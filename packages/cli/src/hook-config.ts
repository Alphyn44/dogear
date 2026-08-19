import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CLI_ENTRY } from './detect.js'
import { insertAt, pruneEmpty, removeAt, stripBom } from './json-insert.js'
import type { Plan, Step, Undo, Wiring } from './scaffold.js'

/**
 * Claude Code's `UserPromptSubmit` hook — E3 (#28), the capability tier on top of MCP.
 *
 * **An upgrade, never a requirement.** ./mcp-config.ts is the baseline and works everywhere;
 * this is what makes "type anything and it just happens" true where the agent supports it.
 * `--no-hook` skips it and leaves an install that is complete, which is the acceptance
 * criterion rather than a courtesy. Claude Code is currently the only agent that can do this at
 * all — Cursor's `beforeSubmitPrompt` cannot inject context and Codex's is global and behind a
 * feature flag. See the brief's Delivery section.
 *
 * **Merged, never clobbered.** Someone else's `UserPromptSubmit` entry has to survive an init,
 * which is why the three shapes below all *insert* rather than assign. This repository's own
 * `.claude/settings.json` is the case in point: it carries six `PreToolUse` hooks and three
 * `Stop` hooks that an init must not disturb.
 *
 * **`node` plus a path, never `command: "dogear"`.** A global npm bin on Windows is a `.cmd`
 * shim and the exec form cannot run one. `${CLAUDE_PROJECT_DIR}` is expanded by Claude Code
 * itself, which is what keeps the written config portable across machines. Both details are
 * pinned in the brief's Delivery section; do not "simplify" either.
 *
 * **`timeout: 10`, against a 30s default.** `UserPromptSubmit`'s default is 30 seconds rather
 * than the 600 that applies elsewhere, and dogear's hook completes in milliseconds — so ten
 * seconds is a fast failure rather than a limit anything legitimate will reach.
 */

/** Repository-relative, forward-slashed. */
const SETTINGS = '.claude/settings.json'

/** The event. It takes no matcher — any `matcher` field is silently ignored. */
const EVENT = 'UserPromptSubmit'

/**
 * The entry, exactly as the brief specifies it.
 *
 * `${CLAUDE_PROJECT_DIR}` rather than a bare relative path because a hook's working directory
 * is the session's, not the repository's — unlike an MCP server, which the client spawns at the
 * project root. That asymmetry is why this path and ./mcp-config.ts's differ.
 */
const ENTRY = {
  hooks: [
    {
      type: 'command',
      command: 'node',
      args: [`\${CLAUDE_PROJECT_DIR}/${CLI_ENTRY}`, 'hook'],
      timeout: 10,
    },
  ],
} as const

export function createHookStep(wiring: Wiring): Step {
  return {
    name: 'prompt-hook',
    plan: (root) => {
      // Two independent reasons to do nothing, and neither is a failure: the user declined, or
      // there is no Claude Code here to hook into.
      if (!wiring.hook) return undefined
      if (!wiring.agents.includes('claude')) return undefined

      const path = join(root, ...SETTINGS.split('/'))
      const existing = readIfFile(path)

      if (existing === undefined) {
        return {
          change: {
            summary: `created ${SETTINGS}`,
            apply: () => write(root, path, fresh()),
          },
        }
      }

      const parsed = parse(existing)
      if (parsed === undefined) return { notes: [unreadable()] }
      if (wired(parsed)) return undefined

      const merged = merge(existing, parsed)
      if (merged === undefined) return { notes: [unplaceable()] }

      const plan: Plan = {
        change: {
          summary: `merged the prompt hook into ${SETTINGS}`,
          apply: () => {
            // Re-read and re-splice, as ./mcp-config.ts and ./gitignore.ts do. Of every file
            // init touches this is the likeliest to be open in an editor, since it is where
            // the user configures the agent they are running init from.
            const current = readIfFile(path)
            if (current === undefined) return write(root, path, fresh())

            const now = parse(current)
            if (now !== undefined && wired(now)) return

            const second = now === undefined ? undefined : merge(current, now)

            if (second === undefined) {
              throw new Error(
                `${SETTINGS} changed while dogear was working and can no longer be edited ` +
                  'safely. Re-run dogear init.',
              )
            }

            writeFileSync(path, second, 'utf8')
          },
        },
      }

      return plan
    },
  }
}

/**
 * Take the hook back out — E6 (#39), and **the first thing `dogear init --undo` does**.
 *
 * Everything else init writes is inert once the CLI is gone: an orphaned `.mcp.json` entry
 * costs a server the client fails to spawn once a session, and an orphaned `.gitignore` rule
 * costs a line. This one runs `node <path> hook` on **every prompt the user types**, against a
 * path that no longer exists. That is the whole reason #39 is a command rather than a paragraph
 * in the README, and it is why this sits at the top of `UNDO_STEPS` — before anything that
 * could fail, since `apply` stops at the first failure.
 *
 * **The array is spliced, never assigned.** Other people's `UserPromptSubmit` entries survive,
 * which is the same requirement as on the way in and the same primitive answering it — see
 * ./json-insert.ts.
 *
 * **`.claude/` itself is never removed, even if this empties it.** init creates the directory
 * on the way in, so removing it looks symmetric; it is not. `.claude/` belongs to Claude Code,
 * ./detect.ts treats it as the marker that Claude Code is used here at all, and an empty one is
 * inert. The same goes for `.cursor/` and `.vscode/` in ./mcp-config.ts.
 */
export const hookRemoval: Undo = {
  name: 'prompt-hook',
  plan: (root) => {
    const path = join(root, ...SETTINGS.split('/'))
    const existing = readIfFile(path)
    if (existing === undefined) return undefined

    // Byte-identical to what init writes into a repository that had no settings file: init
    // created it, nobody has touched it since, and dogear's hook is the only thing in it.
    // Deleting is the honest inverse — leaving `{"hooks": {"UserPromptSubmit": []}}` behind is
    // litter that still says dogear was here.
    if (existing === fresh()) {
      return {
        change: {
          summary: `deleted ${SETTINGS}`,
          apply: () => discard(path, fresh()),
        },
      }
    }

    const parsed = parse(existing)
    if (parsed === undefined) return { notes: [unreadableRemoval()] }
    if (!wired(parsed)) return undefined

    if (withoutHook(existing, parsed) === undefined) {
      return { notes: [unremovable()] }
    }

    const plan: Plan = {
      change: {
        summary: `removed the prompt hook from ${SETTINGS}`,
        apply: () => {
          // Re-read and re-splice, as every `apply` in this package does. Of every file undo
          // touches this is still the likeliest to be open in an editor.
          const current = readIfFile(path)
          if (current === undefined) return

          const now = parse(current)
          if (now === undefined || !wired(now)) return

          const second = withoutHook(current, now)

          if (second === undefined) {
            throw new Error(
              `${SETTINGS} changed while dogear was working and can no longer be edited ` +
                'safely. Re-run dogear init --undo.',
            )
          }

          writeFileSync(path, second, 'utf8')
        },
      },
    }

    return plan
  },
}

/**
 * The existing file with every dogear hook spliced out, or `undefined` if one could not be.
 *
 * **A loop rather than a single splice.** `wired()` makes a second entry unreachable *through
 * init*, but a hand-edited file can hold two — and an undo that left one behind would leave
 * exactly the residue this ticket exists to remove. It terminates because each pass removes one
 * array element, so the array it is searching strictly shrinks.
 */
function withoutHook(source: string, parsed: Parsed): string | undefined {
  let text = source
  let current: Parsed | undefined = parsed

  for (;;) {
    if (current === undefined) return undefined

    const index = dogearIndex(current)
    if (index === undefined) break

    const next = removeAt(text, ['hooks', EVENT, index])
    if (next === undefined) return undefined

    text = next
    current = parse(text)
  }

  // Then the containers, if dogear's entry was the only thing in them. Without this a
  // repository that had no `hooks` key before init keeps `"hooks": {"UserPromptSubmit": []}`
  // forever — inert, and still saying dogear was here. See `pruneEmpty`.
  return pruneEmpty(pruneEmpty(text, ['hooks', EVENT]), ['hooks'])
}

/**
 * Delete a file, having first confirmed it is still exactly what planning saw.
 *
 * The one `apply` in this package that destroys rather than edits, so the re-check is a
 * different kind of load-bearing: every other one guards against writing over an edit, and this
 * one guards against deleting one. A file that changed between plan and apply is no longer the
 * file whose whole contents dogear wrote.
 */
function discard(path: string, expected: string): void {
  if (readIfFile(path) !== expected) {
    throw new Error(
      `${SETTINGS} changed while dogear was working, so it was left alone rather than ` +
        'deleted. Re-run dogear init --undo.',
    )
  }

  rmSync(path)
}

function unreadableRemoval(): string {
  return (
    `${SETTINGS} could not be parsed, so dogear left it alone and its prompt hook is still ` +
    `there. Remove the "${EVENT}" entry running \`${CLI_ENTRY} hook\` by hand.`
  )
}

function unremovable(): string {
  return (
    `${SETTINGS} is not a shape dogear can edit safely, so it left it alone and its prompt ` +
    `hook is still there. Remove the "${EVENT}" entry running \`${CLI_ENTRY} hook\` by hand.`
  )
}

/**
 * The existing file with the hook added, or `undefined` if it could not be placed.
 *
 * **Three shapes, one primitive.** Which closing bracket the entry goes in front of depends on
 * how much of the structure is already there, and that is the whole of the case analysis:
 *
 * | Existing state | Insert into |
 * |---|---|
 * | no `hooks` key | the root object |
 * | `hooks` present, no `UserPromptSubmit` | the `hooks` object |
 * | `hooks.UserPromptSubmit` present | that array |
 *
 * The third is the one that matters — it is what "existing hooks survive" means, because the
 * entry joins the array rather than replacing it.
 *
 * **A key that is present but holds the wrong kind of value declines, and that is not
 * fussiness.** `{"hooks": "x"}` is valid JSON, so it parses, and a merge that only asked "is
 * this an object?" would insert a *second* `"hooks"` key beside it. `JSON.parse` accepts
 * duplicates and keeps the last — so the result sails through the guard inside `insertAt` and
 * leaves the user with a settings file silently shadowing what they wrote. Init cannot tell a
 * typo it should route around from data it would be destroying, so it says so and writes
 * nothing. ./malformed.test.ts is the guard, and it found this rather than predicting it.
 */
function merge(source: string, parsed: Parsed): string | undefined {
  const entry = JSON.stringify(ENTRY, null, 2)

  if (!has(parsed, 'hooks')) {
    return insertAt(
      source,
      [],
      `"hooks": {\n  ${indent(`"${EVENT}": [\n  ${indent(entry)}\n]`)}\n}`,
    )
  }

  // Present but not an object — decline. See the note above `merge`: inserting beside it makes
  // a duplicate key, and a duplicate key parses.
  const hooks = parsed.hooks
  if (!isObject(hooks)) return undefined

  if (!has(hooks, EVENT)) {
    return insertAt(source, ['hooks'], `"${EVENT}": [\n  ${indent(entry)}\n]`)
  }

  return Array.isArray(hooks[EVENT])
    ? insertAt(source, ['hooks', EVENT], entry)
    : undefined
}

/**
 * Is the key there at all, whatever it holds?
 *
 * `hasOwnProperty` rather than a check against `undefined`, matching ./detect.ts's `isDeclared`:
 * the question is whether the *user's file* has the key, and `null` is a key that is present.
 * Getting this wrong is exactly what produces the duplicate.
 */
function has(value: Parsed, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** Push the lines after the first in by one level. */
function indent(snippet: string): string {
  return snippet.split('\n').join('\n  ')
}

/** A whole file, for a repository with no `.claude/settings.json`. */
function fresh(): string {
  return `${JSON.stringify({ hooks: { [EVENT]: [ENTRY] } }, null, 2)}\n`
}

function write(root: string, path: string, contents: string): void {
  if (readIfFile(path) === undefined && existsAnything(path)) {
    throw new Error(
      `${SETTINGS} exists at ${root} but is not a regular file. Remove it and re-run — ` +
        "dogear merges its prompt hook into Claude Code's settings there.",
    )
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

/**
 * Is dogear's hook already there?
 *
 * Identified by what it *runs* rather than by an exact match on the entry: a user who raised
 * the timeout or moved the entry within the array still has dogear's hook, and re-adding it
 * would give them two. `@dogear/cli` in the path plus `hook` in the arguments is the narrowest
 * pair that cannot match anything else.
 */
function wired(parsed: Parsed): boolean {
  return dogearIndex(parsed) !== undefined
}

/**
 * Where dogear's hook sits in the `UserPromptSubmit` array, if it is there at all.
 *
 * E6 (#39) needed the position rather than the fact, and {@link wired} is now derived from it
 * so the two can never develop different ideas about which entry is dogear's — an undo that
 * identified it more loosely than init would delete someone else's hook, and one that
 * identified it more tightly would leave dogear's behind.
 */
function dogearIndex(parsed: Parsed): number | undefined {
  const hooks = parsed.hooks
  if (!isObject(hooks)) return undefined

  const entries = hooks[EVENT]
  if (!Array.isArray(entries)) return undefined

  const index = entries.findIndex(
    (entry) => isObject(entry) && commands(entry).some(isDogear),
  )

  return index === -1 ? undefined : index
}

function commands(entry: Parsed): readonly Parsed[] {
  const inner = entry.hooks
  return Array.isArray(inner) ? inner.filter(isObject) : []
}

function isDogear(command: Parsed): boolean {
  const args = command.args
  if (!Array.isArray(args)) return false

  const text = args.filter((arg): arg is string => typeof arg === 'string')
  return text.some((arg) => arg.includes('@dogear/cli')) && text.includes('hook')
}

function unreadable(): string {
  return (
    `${SETTINGS} could not be parsed, so dogear left it alone and registered no prompt ` +
    'hook. MCP still works; fix the file and re-run to add the hook.'
  )
}

function unplaceable(): string {
  return (
    `${SETTINGS} is not a shape dogear can edit safely, so it left it alone and registered ` +
    `no prompt hook. MCP still works; add a "${EVENT}" entry running ` +
    `\`node \${CLAUDE_PROJECT_DIR}/${CLI_ENTRY} hook\` to enable it.`
  )
}

type Parsed = Record<string, unknown>

/**
 * The file as an object, or `undefined` for anything that is not one.
 *
 * `stripBom` because several Windows editors write one and `JSON.parse` throws on it — a
 * settings file that is entirely valid would otherwise be reported as unreadable. The BOM stays
 * in the text that gets spliced and written; only the parse sees it removed.
 */
function parse(source: string): Parsed | undefined {
  let value: unknown
  try {
    value = JSON.parse(stripBom(source))
  } catch {
    return undefined
  }

  return isObject(value) ? value : undefined
}

function isObject(value: unknown): value is Parsed {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readIfFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

function existsAnything(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
