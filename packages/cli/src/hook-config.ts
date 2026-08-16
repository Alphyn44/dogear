import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CLI_ENTRY } from './detect.js'
import { insertAt } from './json-insert.js'
import type { Plan, Step, Wiring } from './scaffold.js'

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
 */
function merge(source: string, parsed: Parsed): string | undefined {
  const entry = JSON.stringify(ENTRY, null, 2)
  const hooks = parsed.hooks

  if (!isObject(hooks)) {
    return insertAt(
      source,
      [],
      `"hooks": {\n  ${indent(`"${EVENT}": [\n  ${indent(entry)}\n]`)}\n}`,
    )
  }

  if (!Array.isArray(hooks[EVENT])) {
    return insertAt(source, ['hooks'], `"${EVENT}": [\n  ${indent(entry)}\n]`)
  }

  return insertAt(source, ['hooks', EVENT], entry)
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
  const hooks = parsed.hooks
  if (!isObject(hooks)) return false

  const entries = hooks[EVENT]
  if (!Array.isArray(entries)) return false

  return entries.some((entry) => isObject(entry) && commands(entry).some(isDogear))
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

function parse(source: string): Parsed | undefined {
  let value: unknown
  try {
    value = JSON.parse(source)
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
