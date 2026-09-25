import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Agent } from './detect.js'
import { insertAt, pruneEmpty, removeAt, stripBom } from './json-insert.js'
import type { Plan, Step, Undo, Wiring } from './scaffold.js'

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

/**
 * The server entry itself. `node <path>`, for the Windows reason at
 * {@link import('./detect.js').CLI_ENTRY}.
 *
 * A function of the path since #75, which made the path depend on where the repository keeps
 * `dogear-cli`. Every caller passes `Wiring.entry`, apart from undo, which passes the path the
 * file already names.
 */
function server(entry: string): {
  readonly command: 'node'
  readonly args: readonly string[]
} {
  return { command: 'node', args: [entry, 'mcp'] }
}

/** The key the entry lives under, and what makes re-running a no-op. */
const NAME = 'dogear'

/** One file's worth of work, decided at plan time. */
interface Job {
  readonly file: string
  /** The full text to write. */
  readonly contents: string
  /** The CLI path it names, which `apply` needs to splice a second time. */
  readonly entry: string
}

export function createMcpStep(wiring: Wiring): Step {
  return {
    name: 'mcp-registration',
    plan: (root) => {
      const jobs: Job[] = []
      const notes: string[] = []

      for (const agent of wiring.agents) {
        const target = TARGETS[agent]
        const outcome = planOne(root, target, wiring.entry)

        if (outcome === undefined) continue
        if (typeof outcome === 'string') notes.push(outcome)
        else jobs.push(outcome)
      }

      // An absent local `dogear-cli` is **not** noted here. It is a fact about the repository
      // rather than about what this step did, so it belongs with ./scaffold.ts's `remarks()` —
      // see `cliNotInstalled` there, and G3 (#44) in the Decisions log for the round trip.
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
 * Take the registration back out — E6 (#39). One {@link Undo} per target file.
 *
 * **Three entries rather than one, and that is the report's doing.** A `Plan` carries a single
 * `Change` with a single past-tense summary, and undo has two verbs to use: `deleted` for a
 * file that goes entirely and `removed` for one that is spliced. A repository with both
 * `.mcp.json` (created by init, untouched) and `.cursor/mcp.json` (with servers of its own)
 * needs one of each, and a single step could only have reported one — or joined them into a
 * summary whose leading verb `--dry-run` would then convert wrongly. Splitting is what keeps
 * every line honest. They share a `name`, which is internal; ./scaffold.test.ts pairs on it.
 *
 * **Driven by {@link TARGETS}, never by the {@link Wiring}.** Init picks its targets from
 * resolved detection; undo cannot. Init with `--agent=cursor`, delete `.cursor/`, and detection
 * now says `claude` — a wiring-driven undo would walk straight past the file it wrote. So all
 * three are examined unconditionally, and a repository that never had one simply plans nothing.
 * See {@link Undo} for the rest of that argument.
 */
export const mcpRemovals: readonly Undo[] = Object.values(TARGETS).map(createMcpRemoval)

function createMcpRemoval(target: Target): Undo {
  return {
    name: 'mcp-registration',
    plan: (root) => {
      const path = join(root, ...target.file.split('/'))
      const existing = readIfFile(path)
      if (existing === undefined) return undefined

      const parsed = parse(existing)
      if (parsed === undefined) return { notes: [unreadableRemoval(target)] }
      if (!registered(parsed, target)) return undefined

      // Byte-identical to what init writes into a repository that had no config at all: init
      // created this file, nobody has touched it since, and dogear's entry is the only thing in
      // it. Deleting is the honest inverse — leaving `{"mcpServers": {}}` behind is litter that
      // still says dogear was here. Anything else, down to a changed indent, is spliced.
      //
      // The fresh file is rebuilt from the path the entry itself names (#75). Undo never runs
      // detection, so it cannot know which package init chose, and a comparison against the
      // root's path alone would splice a `web/node_modules/...` file init wrote whole.
      const entry = registeredPath(parsed, target)
      if (entry !== undefined && existing === fresh(target, entry)) {
        return {
          change: {
            summary: `deleted ${target.file}`,
            apply: () => discard(path, target, existing),
          },
        }
      }

      if (withoutServer(existing, target) === undefined) {
        return { notes: [unremovable(target)] }
      }

      const plan: Plan = {
        change: {
          summary: `removed ${NAME} from ${target.file}`,
          apply: () => {
            // Re-read and re-splice, exactly as the insert side does and for the same reason.
            const current = readIfFile(path)
            if (current === undefined) return

            const now = parse(current)
            if (now === undefined || !registered(now, target)) return

            const second = withoutServer(current, target)

            if (second === undefined) {
              throw new Error(
                `${target.file} changed while dogear was working and can no longer be ` +
                  'edited safely. Re-run dogear init --undo.',
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
 * The file with dogear's entry gone, and the container too if that emptied it.
 *
 * A `"mcpServers": {}` left behind is inert and still says dogear was here — see `pruneEmpty`,
 * which is also where the one case it gets wrong is argued.
 */
function withoutServer(source: string, target: Target): string | undefined {
  const removed = removeAt(source, [target.container, NAME])
  return removed === undefined ? undefined : pruneEmpty(removed, [target.container])
}

/**
 * Delete a file, having first confirmed it is still exactly what planning saw.
 *
 * Every other `apply` here re-reads to avoid writing over an edit; this one re-reads to avoid
 * *deleting* one. A file that changed between plan and apply is no longer a file whose entire
 * contents dogear wrote, so the premise for removing it whole has gone.
 */
function discard(path: string, target: Target, expected: string): void {
  if (readIfFile(path) !== expected) {
    throw new Error(
      `${target.file} changed while dogear was working, so it was left alone rather than ` +
        'deleted. Re-run dogear init --undo.',
    )
  }

  rmSync(path)
}

function unreadableRemoval(target: Target): string {
  return (
    `${target.file} could not be parsed, so dogear left it alone and its "${NAME}" entry is ` +
    `still registered under "${target.container}". Remove it by hand.`
  )
}

function unremovable(target: Target): string {
  return (
    `${target.file} is not a shape dogear can edit safely, so it left it alone and its ` +
    `"${NAME}" entry is still registered under "${target.container}". Remove it by hand.`
  )
}

/**
 * What this file needs: a {@link Job}, a note explaining why there isn't one, or nothing.
 *
 * **The splice happens here, at plan time, and that is deliberate.** Planning reads and does not
 * write, so it is free to work out the exact bytes — and doing so is the only way "we could not
 * place this safely" becomes a `Plan.note` instead of an `apply()` that fails half way through a
 * list of files. `apply` re-reads and re-splices anyway; see {@link apply}.
 */
function planOne(root: string, target: Target, entry: string): Job | string | undefined {
  const path = join(root, ...target.file.split('/'))
  const existing = readIfFile(path)

  if (existing === undefined) {
    // Nothing there — or something there that is not a regular file, which `apply` re-checks
    // and reports properly rather than letting `writeFileSync` produce a bare EISDIR.
    return { file: target.file, contents: fresh(target, entry), entry }
  }

  const parsed = parse(existing)
  if (parsed === undefined) return unreadable(target, entry)

  if (registered(parsed, target)) {
    const current = registeredPath(parsed, target)
    return current === entry ? undefined : stale(target, current, entry)
  }

  const merged = merge(existing, parsed, target, entry)
  return merged === undefined
    ? unplaceable(target, entry)
    : { file: target.file, contents: merged, entry }
}

/** A whole file, for a repository that had none. */
function fresh(target: Target, entry: string): string {
  return `${JSON.stringify({ [target.container]: { [NAME]: server(entry) } }, null, 2)}\n`
}

/**
 * The CLI path dogear's entry names, or `undefined` if it does not name one as `args[0]`.
 *
 * Read by the stale check and by undo, both since #75. Neither may assume the root's path any
 * more: the stale check exists because a registration can name a path init would no longer
 * write, and undo has to rebuild the file init wrote from whatever path init chose at the time.
 */
function registeredPath(parsed: Parsed, target: Target): string | undefined {
  const container = parsed[target.container]
  const entry = isObject(container) ? container[NAME] : undefined
  const args = isObject(entry) ? entry.args : undefined
  return Array.isArray(args) && typeof args[0] === 'string' ? args[0] : undefined
}

/**
 * A registration naming a different path from the one init would write now (#75).
 *
 * **A note, never a rewrite.** Every repository set up before #75 in a layout with no root
 * `package.json` carries the root's path, which never resolves there, and `registered()` alone
 * would report `nothing changed` over it forever. Repointing it in place was the alternative and
 * was declined: an entry pointing somewhere else may have been pointed there on purpose, and
 * editing a value someone chose is the line ./gitignore.ts already declines to cross. The note
 * names the undo-then-init round trip, which does the repair with machinery that already exists.
 */
function stale(target: Target, current: string | undefined, entry: string): string {
  const now =
    current === undefined
      ? `registers "${NAME}" without a CLI path dogear can read`
      : `registers "${NAME}" at ${current}`

  return (
    `${target.file} ${now}, but this repository's dogear-cli belongs at ${entry}. Run ` +
    '`dogear init --undo` and then `dogear init` to repoint it.'
  )
}

/**
 * The existing file with dogear added, or `undefined` if it could not be placed.
 *
 * Two shapes, one primitive: the container is either already there — in which case the entry
 * goes into it — or it is not, in which case the container goes into the root object carrying
 * the entry. Anything else (a container that is not an object, a document whose root is an
 * array) falls out of `insertAt` as `undefined` and becomes a note.
 */
function merge(
  source: string,
  parsed: Parsed,
  target: Target,
  entry: string,
): string | undefined {
  // Relative indentation only. `insertAt` prefixes every line of the snippet with the indent it
  // found in the file, so a snippet that arrived pre-indented would come out doubly so.
  const snippet = `${JSON.stringify(NAME)}: ${JSON.stringify(server(entry), null, 2)}`

  if (!has(parsed, target.container)) {
    return insertAt(
      source,
      [],
      `${JSON.stringify(target.container)}: {\n  ${indent(snippet)}\n}`,
    )
  }

  // Present but not an object — `{"mcpServers": null}` and friends. Declining rather than
  // inserting beside it, because a second `"mcpServers"` key *parses*: `JSON.parse` keeps the
  // last duplicate, so the guard inside `insertAt` cannot catch it and the user's own value
  // would be silently shadowed. ./hook-config.ts has the same trap and the same answer, and
  // ./malformed.test.ts covers both.
  return isObject(parsed[target.container])
    ? insertAt(source, [target.container], snippet)
    : undefined
}

/** Is the key there at all, whatever it holds? `null` is present; absent is absent. */
function has(value: Parsed, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
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

function unreadable(target: Target, entry: string): string {
  return (
    `${target.file} could not be parsed, so dogear left it alone. Add a "${NAME}" entry ` +
    `under "${target.container}": {"command": "node", "args": ["${entry}", "mcp"]}`
  )
}

function unplaceable(target: Target, entry: string): string {
  return (
    `${target.file} is not a shape dogear can edit safely, so it left it alone. Add a ` +
    `"${NAME}" entry under "${target.container}": {"command": "node", "args": ` +
    `["${entry}", "mcp"]}`
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

  const merged =
    parsed === undefined ? undefined : merge(current, parsed, target, job.entry)

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

/**
 * A parsed object, or `undefined` for anything this cannot edit — including a root array.
 *
 * `stripBom` for the reason ./hook-config.ts gives: a Windows editor's byte order mark makes
 * `JSON.parse` throw on a file that is otherwise perfectly valid. It is removed for the parse
 * and kept in the text that gets written.
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
