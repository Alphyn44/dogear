import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Agent } from './detect.js'
import { CLI_ENTRY } from './detect.js'
import { insertAt } from './json-insert.js'
import type { Plan, Step, Wiring } from './scaffold.js'

/**
 * The MCP server, registered wherever the repository's agent will look — E3 (#28).
 *
 * **This is the baseline and it is never skipped.** The brief's Delivery section puts it
 * plainly: MCP is the product, and the prompt hook is an upgrade you get where your tooling
 * allows one. So this step runs for every agent, ./hook-config.ts runs for one of them, and
 * `--no-hook` leaves an install that is complete rather than degraded.
 *
 * **Three agents, one mechanism** — a project-local JSON file naming a command to spawn. That
 * shared shape is what makes them a table rather than three implementations, and it is also
 * what excludes Codex: its registration is global, outside the repository, and TOML. See
 * {@link import('./detect.js').Agent}.
 *
 * **A file that already exists is edited in place, never re-serialised.** ./json-insert.ts
 * carries the reasoning; the consequence here is that this step has two outcomes rather than
 * one — it writes, or it declines and says so in a note. Declining is not a failure: a config
 * with comments in it is an ordinary thing to find, and the correct response is to tell the
 * user what to add rather than to reformat a file they hand-wrote.
 */

/** What one agent needs, and where. */
interface Target {
  /** Repository-relative, forward-slashed — what the report prints. */
  readonly file: string
  /**
   * The object new servers go into.
   *
   * VS Code is the odd one out with `servers`; Claude Code and Cursor both use `mcpServers`.
   * One field name is the entire schema difference between them, which is why it is a table
   * entry rather than a second code path.
   */
  readonly container: string
}

const TARGETS: Record<Agent, Target> = {
  claude: { file: '.mcp.json', container: 'mcpServers' },
  cursor: { file: '.cursor/mcp.json', container: 'mcpServers' },
  vscode: { file: '.vscode/mcp.json', container: 'servers' },
}

/** The server entry itself. `node <path>`, for the Windows reason at {@link CLI_ENTRY}. */
const SERVER = {
  command: 'node',
  args: [CLI_ENTRY, 'mcp'],
} as const

/** The key the entry lives under, and what makes re-running a no-op. */
const NAME = 'dogear'

/** One file's worth of work, decided at plan time. */
interface Job {
  readonly file: string
  /** The full text to write. */
  readonly contents: string
}

export function createMcpStep(wiring: Wiring): Step {
  return {
    name: 'mcp-registration',
    plan: (root) => {
      const jobs: Job[] = []
      const notes: string[] = []

      for (const agent of wiring.agents) {
        const target = TARGETS[agent]
        const outcome = planOne(root, target)

        if (outcome === undefined) continue
        if (typeof outcome === 'string') notes.push(outcome)
        else jobs.push(outcome)
      }

      // Only worth saying when something is actually being registered. A repository whose
      // configs are all already correct does not need telling how the CLI resolves.
      if (jobs.length > 0 && wiring.cli === 'absent') notes.push(missingCli())

      if (jobs.length === 0) return notes.length === 0 ? undefined : { notes }

      const plan: Plan = {
        change: {
          summary: `registered ${NAME} in ${jobs.map((job) => job.file).join(', ')}`,
          apply: () => {
            for (const job of jobs) apply(root, job)
          },
        },
        notes,
      }

      return plan
    },
  }
}

/**
 * What this file needs: a {@link Job}, a note explaining why there isn't one, or nothing.
 *
 * **The splice happens here, at plan time, and that is deliberate.** Planning reads and does not
 * write, so it is free to work out the exact bytes — and doing so is the only way "we could not
 * place this safely" becomes a `Plan.note` instead of an `apply()` that fails half way through a
 * list of files. `apply` re-reads and re-splices anyway; see {@link apply}.
 */
function planOne(root: string, target: Target): Job | string | undefined {
  const path = join(root, ...target.file.split('/'))
  const existing = readIfFile(path)

  if (existing === undefined) {
    // Nothing there — or something there that is not a regular file, which `apply` re-checks
    // and reports properly rather than letting `writeFileSync` produce a bare EISDIR.
    return { file: target.file, contents: fresh(target) }
  }

  const parsed = parse(existing)
  if (parsed === undefined) return unreadable(target)
  if (registered(parsed, target)) return undefined

  const merged = merge(existing, parsed, target)
  return merged === undefined
    ? unplaceable(target)
    : { file: target.file, contents: merged }
}

/** A whole file, for a repository that had none. */
function fresh(target: Target): string {
  return `${JSON.stringify({ [target.container]: { [NAME]: SERVER } }, null, 2)}\n`
}

/**
 * The existing file with dogear added, or `undefined` if it could not be placed.
 *
 * Two shapes, one primitive: the container is either already there — in which case the entry
 * goes into it — or it is not, in which case the container goes into the root object carrying
 * the entry. Anything else (a container that is not an object, a document whose root is an
 * array) falls out of `insertAt` as `undefined` and becomes a note.
 */
function merge(source: string, parsed: Parsed, target: Target): string | undefined {
  // Relative indentation only. `insertAt` prefixes every line of the snippet with the indent it
  // found in the file, so a snippet that arrived pre-indented would come out doubly so.
  const entry = `${JSON.stringify(NAME)}: ${JSON.stringify(SERVER, null, 2)}`

  return isObject(parsed[target.container])
    ? insertAt(source, [target.container], entry)
    : insertAt(
        source,
        [],
        `${JSON.stringify(target.container)}: {\n  ${indent(entry)}\n}`,
      )
}

/** Push a multi-line snippet in by one level, for the lines after the first. */
function indent(snippet: string): string {
  return snippet.split('\n').join('\n  ')
}

/** Is dogear already registered here? Idempotency, with no second predicate to drift. */
function registered(parsed: Parsed, target: Target): boolean {
  const container = parsed[target.container]
  return isObject(container) && Object.prototype.hasOwnProperty.call(container, NAME)
}

function unreadable(target: Target): string {
  return (
    `${target.file} could not be parsed, so dogear left it alone. Add a "${NAME}" entry ` +
    `under "${target.container}": {"command": "node", "args": ["${CLI_ENTRY}", "mcp"]}`
  )
}

function unplaceable(target: Target): string {
  return (
    `${target.file} is not a shape dogear can edit safely, so it left it alone. Add a ` +
    `"${NAME}" entry under "${target.container}": {"command": "node", "args": ` +
    `["${CLI_ENTRY}", "mcp"]}`
  )
}

function missingCli(): string {
  return (
    `the registration points at ${CLI_ENTRY}, which is not installed here. Run ` +
    '`npm i -D @dogear/cli` so the path resolves for everyone who clones this repository.'
  )
}

/**
 * Write one job.
 *
 * **Re-read and re-splice rather than trusting the planned bytes**, the same re-check
 * ./gitignore.ts and ./config.ts do. Every `plan()` runs before any `apply()`, so the file may
 * have moved underneath us — and for a file the user is likely to have open in an editor, that
 * is not a theoretical concern. A second splice that fails throws, which the runner reports and
 * a re-run resumes from.
 */
function apply(root: string, job: Job): void {
  const path = join(root, ...job.file.split('/'))
  const current = readIfFile(path)

  if (current === undefined && existsAnything(path)) {
    throw new Error(
      `${job.file} exists at ${root} but is not a regular file. Remove it and re-run — ` +
        'dogear registers its MCP server there.',
    )
  }

  if (current === undefined) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, job.contents, 'utf8')
    return
  }

  const parsed = parse(current)
  const target = targetFor(job.file)

  // It arrived while we were planning, which is a no-op rather than a failure.
  if (parsed !== undefined && registered(parsed, target)) return

  const merged = parsed === undefined ? undefined : merge(current, parsed, target)

  if (merged === undefined) {
    throw new Error(
      `${job.file} changed while dogear was working and can no longer be edited safely. ` +
        'Re-run dogear init.',
    )
  }

  writeFileSync(path, merged, 'utf8')
}

function targetFor(file: string): Target {
  const found = Object.values(TARGETS).find((target) => target.file === file)
  if (found === undefined) throw new Error(`no MCP target for ${file}`)
  return found
}

type Parsed = Record<string, unknown>

/** A parsed object, or `undefined` for anything this cannot edit — including a root array. */
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

/** The file's contents, or `undefined` if it is absent or is not a regular file. */
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
