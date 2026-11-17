import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { insertAt, pruneEmpty, removeAt, stripBom } from './json-insert.js'
import type { Plan, Step, Undo, Wiring } from './scaffold.js'

/**
 * Everything dogear writes into `.claude/settings.json`: Claude Code's `UserPromptSubmit` hook
 * (E3, #28) and the permission rules that pre-approve dogear's MCP tools (#76).
 *
 * **One step owns the file, and that is the reason this module is not two.** Every `plan()`
 * runs before any `apply()`, so two steps planning against the same file would each have to
 * simulate the other's edit to report `created` rather than `merged` on the way in, and `deleted`
 * rather than `removed` on the way out. One owner keeps one report line per run and a short list
 * of whole files init can have written, which is what the delete-or-splice rule compares against.
 *
 * **The hook is an upgrade, never a requirement.** ./mcp-config.ts is the baseline and works
 * everywhere; the hook is what makes "type anything and it just happens" true where the agent
 * supports it. `--no-hook` skips it and leaves an install that is complete, which is the
 * acceptance criterion rather than a courtesy. Claude Code is currently the only agent that can
 * do this at all — Cursor's `beforeSubmitPrompt` cannot inject context and Codex's is global and
 * behind a feature flag. See the brief's Delivery section.
 *
 * **The permission rules are written whenever Claude Code is wired, `--no-hook` included.**
 * Without them every `dogear_pending` and `dogear_resolve` call starts with a prompt, which is the
 * loop dogear exists for interrupting itself. Claude Code applies a committed allow rule only after
 * each person accepts its workspace trust dialog, which lists what the rule grants, so writing one
 * does not approve anything on anyone's behalf. Named tools rather than `mcp__dogear__*`, so the
 * dialog says exactly what is granted and a tool added later is never pre-approved under a grant
 * accepted before it existed (see {@link ALLOW}). Cursor and VS Code get no equivalent; the brief's
 * Decisions log says why.
 *
 * **Merged, never clobbered.** Someone else's `UserPromptSubmit` entry and someone else's allow
 * rules have to survive an init, which is why every shape below *inserts* rather than assigns.
 * This repository's own `.claude/settings.json` is the case in point: it carries a permission
 * list and a dozen hooks that an init must not disturb.
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

/** What every form of the CLI path ends with, whichever package it runs through (#75). */
const TAIL = 'dogear-cli/dist/cli.js'

/**
 * The permission rules, one per MCP tool (#76).
 *
 * **A literal, not derived from `TOOLS` in ./tools.ts.** Deriving it would pre-approve a fourth
 * tool the moment one was added, in every repository initialised after that, without anyone
 * deciding that the new tool is as harmless as these three. ./claude-settings.test.ts pairs this
 * list against `TOOLS`, so adding a tool fails a test and forces the decision instead. All three
 * write nothing but `.dogear/queue.json`, and `dogear_pending` writes nothing at all.
 *
 * `mcp__<server>__<tool>`, where the server is the `dogear` key ./mcp-config.ts registers.
 */
export const ALLOW: readonly string[] = [
  'mcp__dogear__dogear_pending',
  'mcp__dogear__dogear_resolve',
  'mcp__dogear__dogear_prune',
]

/** The rule prefix that says a rule is about dogear's server at all. See {@link decided}. */
const SERVER = 'mcp__dogear'

/** Which of the two parts a run wants, or found, or changed. */
interface Parts {
  /** The hook's CLI path argument, or `undefined` for no hook. */
  readonly hook: string | undefined
  readonly rules: boolean
}

/**
 * The path argument, from the repo-relative CLI path in `Wiring.entry`.
 *
 * `${CLAUDE_PROJECT_DIR}` rather than a bare relative path because a hook's working directory
 * is the session's, not the repository's — unlike an MCP server, which the client spawns at the
 * project root. That asymmetry is why this path and ./mcp-config.ts's differ.
 */
function argFor(entry: string): string {
  return `\${CLAUDE_PROJECT_DIR}/${entry}`
}

/**
 * The entry, exactly as the brief specifies it, naming `arg`.
 *
 * A function of the path since #75, for the reason ./mcp-config.ts's `server` gives: the path now
 * depends on where the repository keeps `dogear-cli`, and undo has to rebuild this from whichever
 * path the file already names.
 */
function entryFor(arg: string): Parsed {
  return {
    hooks: [{ type: 'command', command: 'node', args: [arg, 'hook'], timeout: 10 }],
  }
}

export function createClaudeSettingsStep(wiring: Wiring): Step {
  return {
    name: 'claude-settings',
    plan: (root) => {
      // No Claude Code here to configure. `--no-hook` is not a reason to stop: it declines the
      // hook, and the permission rules are wanted either way.
      if (!wiring.agents.includes('claude')) return undefined

      const wanted: Parts = {
        hook: wiring.hook ? argFor(wiring.entry) : undefined,
        rules: true,
      }
      const path = join(root, ...SETTINGS.split('/'))
      const existing = readIfFile(path)

      if (existing === undefined) {
        return {
          change: {
            summary: `created ${SETTINGS}`,
            apply: () => write(root, path, fresh(wanted)),
          },
        }
      }

      const parsed = parse(existing)
      if (parsed === undefined) return { notes: [unreadable(wanted)] }

      const settled = settle(existing, parsed, wanted)
      if (settled.text === undefined) {
        return settled.notes.length === 0 ? undefined : { notes: settled.notes }
      }

      const plan: Plan = {
        change: {
          summary: merged(settled.added),
          apply: () => {
            // Re-read and re-splice, as ./mcp-config.ts and ./gitignore.ts do. Of every file
            // init touches this is the likeliest to be open in an editor, since it is where
            // the user configures the agent they are running init from.
            const current = readIfFile(path)
            if (current === undefined) return write(root, path, fresh(wanted))

            const now = parse(current)
            const second = now === undefined ? undefined : settle(current, now, wanted)

            // Everything planned arrived between plan and apply: a no-op, not a failure.
            if (second !== undefined && second.text === undefined && !second.declined)
              return

            if (second?.text === undefined) {
              throw new Error(
                `${SETTINGS} changed while dogear was working and can no longer be edited ` +
                  'safely. Re-run dogear init.',
              )
            }

            writeFileSync(path, second.text, 'utf8')
          },
        },
        notes: settled.notes,
      }

      return plan
    },
  }
}

/** What {@link settle} made of an existing file. */
interface Settled {
  /** The file with whatever was missing added, or `undefined` when nothing was. */
  readonly text: string | undefined
  readonly added: Parts
  readonly notes: readonly string[]
  /** Whether a wanted part could not be placed, which `apply` has to tell apart from "arrived". */
  readonly declined: boolean
}

/**
 * Add whichever wanted parts are missing, each independently of the other.
 *
 * **Independent is the point.** A `"hooks": "x"` the hook cannot be placed beside says nothing
 * about whether the permission rules can be, so a part that declines becomes a note and the
 * other still lands. The hook is spliced first and the rules into the result; the rules' shape
 * checks read `parsed` rather than a re-parse, which is sound because the hook's splice touches
 * nothing under `permissions`.
 */
function settle(source: string, parsed: Parsed, wanted: Parts): Settled {
  let text = source
  let hook: string | undefined
  let rules = false
  let declined = false
  const notes: string[] = []

  if (wanted.hook !== undefined) {
    if (wired(parsed)) {
      const current = dogearPath(parsed)
      if (current !== wanted.hook) notes.push(stale(current, wanted.hook))
    } else {
      const next = mergeHook(text, parsed, wanted.hook)
      if (next === undefined) {
        notes.push(unplaceable(wanted.hook))
        declined = true
      } else {
        text = next
        hook = wanted.hook
      }
    }
  }

  if (wanted.rules && !decided(parsed)) {
    const next = mergeRules(text, parsed)
    if (next === undefined) {
      notes.push(unallowable())
      declined = true
    } else {
      text = next
      rules = true
    }
  }

  const changed = hook !== undefined || rules
  return { text: changed ? text : undefined, added: { hook, rules }, notes, declined }
}

/** The change line, naming only what this run adds. */
function merged(added: Parts): string {
  if (added.hook !== undefined && added.rules) {
    return `merged the prompt hook and dogear's MCP tool permissions into ${SETTINGS}`
  }

  return added.hook !== undefined
    ? `merged the prompt hook into ${SETTINGS}`
    : `added dogear's MCP tool permissions to ${SETTINGS}`
}

/**
 * Take dogear back out of the file — E6 (#39), and **the first thing `dogear init --undo` does**.
 *
 * Everything else init writes is inert once the CLI is gone: an orphaned `.mcp.json` entry
 * costs a server the client fails to spawn once a session, and an orphaned `.gitignore` rule
 * costs a line. The hook runs `node <path> hook` on **every prompt the user types**, against a
 * path that no longer exists. That is the whole reason #39 is a command rather than a paragraph
 * in the README, and it is why this sits at the top of `UNDO_STEPS` — before anything that
 * could fail, since `apply` stops at the first failure. The permission rules come out with it
 * because they live in the same file; left behind they would be inert, but still say dogear was
 * here.
 *
 * **Only dogear's exact rules, and only from `allow`.** A `mcp__dogear__*` the user wrote, or a
 * tool they moved to `deny`, is their decision rather than init's residue, so it stays.
 *
 * **Arrays are spliced, never assigned.** Other people's `UserPromptSubmit` entries and allow
 * rules survive, which is the same requirement as on the way in and the same primitive answering
 * it — see ./json-insert.ts.
 *
 * **`.claude/` itself is never removed, even if this empties it.** init creates the directory
 * on the way in, so removing it looks symmetric; it is not. `.claude/` belongs to Claude Code,
 * ./detect.ts treats it as the marker that Claude Code is used here at all, and an empty one is
 * inert. The same goes for `.cursor/` and `.vscode/` in ./mcp-config.ts.
 */
export const claudeSettingsRemoval: Undo = {
  name: 'claude-settings',
  plan: (root) => {
    const path = join(root, ...SETTINGS.split('/'))
    const existing = readIfFile(path)
    if (existing === undefined) return undefined

    const parsed = parse(existing)
    if (parsed === undefined) return { notes: [unreadableRemoval()] }

    const found = present(parsed)
    if (!found.hook && !found.rules) return undefined

    // Byte-identical to a whole file init writes into a repository that had none: init created
    // it, nobody has touched it since, and dogear's parts are the only things in it. Deleting is
    // the honest inverse — leaving `{}` behind is litter that still says dogear was here.
    //
    // Three such files, because init has written three: both parts, the rules alone under
    // `--no-hook`, and the hook alone from every init before #76. The hook's forms are rebuilt
    // from the path the hook itself names (#75): undo never runs detection, so it cannot know
    // which package init chose.
    if (freshForms(found.path).includes(existing)) {
      return {
        change: {
          summary: `deleted ${SETTINGS}`,
          apply: () => discard(path, existing),
        },
      }
    }

    if (without(existing, parsed) === undefined) {
      return { notes: [unremovable()] }
    }

    const plan: Plan = {
      change: {
        summary: removed(found),
        apply: () => {
          // Re-read and re-splice, as every `apply` in this package does. Of every file undo
          // touches this is still the likeliest to be open in an editor.
          const current = readIfFile(path)
          if (current === undefined) return

          const now = parse(current)
          if (now === undefined) return

          const left = present(now)
          if (!left.hook && !left.rules) return

          const second = without(current, now)

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

/** Which of dogear's parts a file holds, as undo sees them. */
interface Found {
  readonly hook: boolean
  /** The CLI path the hook runs, when it names one dogear can read. */
  readonly path: string | undefined
  readonly rules: boolean
}

/**
 * The hook as {@link wired} finds it, carrying the path it runs so the fresh forms can be rebuilt;
 * the rules as any one of {@link ALLOW} in `allow`. A hook whose path cannot be read is still
 * dogear's and still comes out; it just cannot match a fresh form, so it is spliced.
 */
function present(parsed: Parsed): Found {
  const hook = wired(parsed)
  return {
    hook,
    path: hook ? dogearPath(parsed) : undefined,
    rules: allowIndex(parsed) !== undefined,
  }
}

/** Every whole file init can have written, given the hook path the file names. */
function freshForms(path: string | undefined): readonly string[] {
  const forms = [fresh({ hook: undefined, rules: true })]
  if (path !== undefined) {
    forms.push(fresh({ hook: path, rules: true }), fresh({ hook: path, rules: false }))
  }
  return forms
}

/** The undo line, naming only what is there to remove. */
function removed(found: Found): string {
  if (found.hook && found.rules) {
    return `removed the prompt hook and dogear's MCP tool permissions from ${SETTINGS}`
  }

  return found.hook
    ? `removed the prompt hook from ${SETTINGS}`
    : `removed dogear's MCP tool permissions from ${SETTINGS}`
}

/** The file with both of dogear's parts spliced out, or `undefined` if either could not be. */
function without(source: string, parsed: Parsed): string | undefined {
  let text = source

  if (wired(parsed)) {
    const next = withoutHook(text, parsed)
    if (next === undefined) return undefined
    text = next
  }

  const now = parse(text)
  if (now === undefined) return undefined

  return allowIndex(now) === undefined ? text : withoutRules(text, now)
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
 * The existing file with every one of {@link ALLOW} spliced out of `permissions.allow`.
 *
 * A loop for the reason {@link withoutHook} gives, and the same cascade after it: a repository
 * that had no `permissions` before init should not keep `"permissions": {"allow": []}`.
 */
function withoutRules(source: string, parsed: Parsed): string | undefined {
  let text = source
  let current: Parsed | undefined = parsed

  for (;;) {
    if (current === undefined) return undefined

    const index = allowIndex(current)
    if (index === undefined) break

    const next = removeAt(text, ['permissions', 'allow', index])
    if (next === undefined) return undefined

    text = next
    current = parse(text)
  }

  return pruneEmpty(pruneEmpty(text, ['permissions', 'allow']), ['permissions'])
}

/**
 * Delete a file, having first confirmed it is still exactly what planning saw.
 *
 * The one `apply` in this module that destroys rather than edits, so the re-check is a
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

// Neither names the full path, because undo does not know it: the file could not be read, or
// could not be edited, so the path it holds is exactly what is unavailable. The package-relative
// tail is the same whichever package init chose (#75), and it is what the user searches for.
function unreadableRemoval(): string {
  return (
    `${SETTINGS} could not be parsed, so dogear left it alone. Remove the "${EVENT}" entry ` +
    `running \`${TAIL} hook\` and dogear's ${SERVER}__ rules in "permissions.allow" by hand.`
  )
}

function unremovable(): string {
  return (
    `${SETTINGS} is not a shape dogear can edit safely, so it left it alone. Remove the ` +
    `"${EVENT}" entry running \`${TAIL} hook\` and dogear's ${SERVER}__ rules in ` +
    '"permissions.allow" by hand.'
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
function mergeHook(source: string, parsed: Parsed, arg: string): string | undefined {
  const entry = JSON.stringify(entryFor(arg), null, 2)

  if (!has(parsed, 'hooks')) {
    return insertAt(
      source,
      [],
      `"hooks": {\n  ${indent(`"${EVENT}": [\n  ${indent(entry)}\n]`)}\n}`,
    )
  }

  // Present but not an object — decline. See the note above: inserting beside it makes a
  // duplicate key, and a duplicate key parses.
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
 * The existing file with {@link ALLOW} added to `permissions.allow`, or `undefined`.
 *
 * The same three shapes as {@link mergeHook}, one level shallower (no `permissions`, no
 * `allow`, or an `allow` array to join), and the same refusal of a key that holds the wrong kind
 * of value, for the same duplicate-key reason. Joining an array is one insert per rule, so each
 * lands as its own element in whatever layout the array already has, and undo can take each back
 * out with the same scanner.
 */
function mergeRules(source: string, parsed: Parsed): string | undefined {
  if (!has(parsed, 'permissions')) {
    return insertAt(
      source,
      [],
      `"permissions": ${JSON.stringify({ allow: ALLOW }, null, 2)}`,
    )
  }

  const permissions = parsed.permissions
  if (!isObject(permissions)) return undefined

  if (!has(permissions, 'allow')) {
    return insertAt(source, ['permissions'], `"allow": ${JSON.stringify(ALLOW, null, 2)}`)
  }

  if (!Array.isArray(permissions.allow)) return undefined

  let text: string | undefined = source
  for (const rule of ALLOW) {
    text = insertAt(text, ['permissions', 'allow'], JSON.stringify(rule))
    if (text === undefined) return undefined
  }

  return text
}

/**
 * Has anyone already decided how dogear's tools are approved here?
 *
 * **Any rule about dogear's server, in any of the three lists, and init stays out.** A
 * `mcp__dogear__*` in `allow` already covers the three; one tool moved to `deny` or `ask` is a
 * choice someone made on purpose; and one deleted from `allow` leaves the other two here as the
 * trace of that choice. Topping up the missing rules on every re-run would override all three
 * cases, so the only thing that earns a write is a file with no opinion on dogear at all.
 */
function decided(parsed: Parsed): boolean {
  const permissions = parsed.permissions
  if (!isObject(permissions)) return false

  return ['allow', 'ask', 'deny'].some((list) => {
    const rules = permissions[list]
    return (
      Array.isArray(rules) &&
      rules.some(
        (rule) =>
          typeof rule === 'string' && (rule === SERVER || rule.startsWith(`${SERVER}__`)),
      )
    )
  })
}

/**
 * Where the first of {@link ALLOW} sits in `permissions.allow`, if any does.
 *
 * Exact strings only, which is narrower than {@link decided} on purpose: undo removes what init
 * wrote, and init never writes a wildcard.
 */
function allowIndex(parsed: Parsed): number | undefined {
  const permissions = parsed.permissions
  if (!isObject(permissions)) return undefined

  const rules = permissions.allow
  if (!Array.isArray(rules)) return undefined

  const index = rules.findIndex(
    (rule) => typeof rule === 'string' && ALLOW.includes(rule),
  )
  return index === -1 ? undefined : index
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

/**
 * A whole file, for a repository with no `.claude/settings.json`.
 *
 * `permissions` ahead of `hooks`, the order Claude Code's own documentation writes them in.
 * The hook-only form is what every init before #76 wrote, byte for byte, which is what lets
 * undo still recognise one.
 */
function fresh(parts: Parts): string {
  const settings: Parsed = {}
  if (parts.rules) settings.permissions = { allow: ALLOW }
  if (parts.hook !== undefined) settings.hooks = { [EVENT]: [entryFor(parts.hook)] }
  return `${JSON.stringify(settings, null, 2)}\n`
}

function write(root: string, path: string, contents: string): void {
  if (readIfFile(path) === undefined && existsAnything(path)) {
    throw new Error(
      `${SETTINGS} exists at ${root} but is not a regular file. Remove it and re-run — ` +
        "dogear merges its prompt hook and tool permissions into Claude Code's settings there.",
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
 * would give them two. `dogear-cli` in the path plus `hook` in the arguments is the narrowest
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
  return text.some((arg) => arg.includes('dogear-cli')) && text.includes('hook')
}

function unreadable(wanted: Parts): string {
  const declined =
    wanted.hook === undefined
      ? "allowed none of dogear's MCP tools"
      : "registered no prompt hook and allowed none of dogear's MCP tools"

  return (
    `${SETTINGS} could not be parsed, so dogear left it alone and ${declined}. MCP still ` +
    'works; fix the file and re-run.'
  )
}

function unplaceable(arg: string): string {
  return (
    `${SETTINGS} is not a shape dogear can edit safely, so it left it alone and registered ` +
    `no prompt hook. MCP still works; add a "${EVENT}" entry running ` +
    `\`node ${arg} hook\` to enable it.`
  )
}

function unallowable(): string {
  return (
    `${SETTINGS} has a "permissions" entry dogear cannot edit safely, so Claude Code will ask ` +
    `before each dogear tool call. Add ${ALLOW.map((rule) => `"${rule}"`).join(', ')} to ` +
    '"permissions.allow" to skip that.'
  )
}

/**
 * A hook running the CLI from a different path than init would write now (#75).
 *
 * The hook's half of ./mcp-config.ts's `stale`, and a note rather than a rewrite for the reason
 * given there. It matters more here: this is the entry that fails on every prompt when its path
 * does not resolve, and a re-run that said `nothing changed` over it is how #75 went unnoticed.
 */
function stale(current: string | undefined, arg: string): string {
  const now =
    current === undefined
      ? 'runs the prompt hook without a CLI path dogear can read'
      : `runs the prompt hook from ${current}`

  return (
    `${SETTINGS} ${now}, but this repository's dogear-cli belongs at ${arg}. Run ` +
    '`dogear init --undo` and then `dogear init` to repoint it.'
  )
}

/**
 * The CLI path dogear's hook runs, found the way {@link dogearIndex} finds the hook itself.
 *
 * The argument naming `dogear-cli`, rather than `args[0]`, because that is what identified the
 * entry as dogear's in the first place ({@link isDogear}), so the two cannot disagree about which
 * argument is the path. Read by the stale check and by undo.
 */
function dogearPath(parsed: Parsed): string | undefined {
  const hooks = parsed.hooks
  const entries = isObject(hooks) ? hooks[EVENT] : undefined
  if (!Array.isArray(entries)) return undefined

  for (const entry of entries) {
    if (!isObject(entry)) continue

    const command = commands(entry).find(isDogear)
    if (command !== undefined) return pathIn(command)
  }

  return undefined
}

function pathIn(command: Parsed): string | undefined {
  const args = command.args
  if (!Array.isArray(args)) return undefined

  return args.find(
    (arg): arg is string => typeof arg === 'string' && arg.includes('dogear-cli'),
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
