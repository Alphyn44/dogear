import { configFile, configRemoval } from './config.js'
import type { Agent, Cli, Detection, DetectedApp } from './detect.js'
import { CLI_ENTRY, detect } from './detect.js'
import { gitignore, gitignoreRemoval } from './gitignore.js'
import { guidance } from './guidance.js'
import { createHookStep, hookRemoval } from './hook-config.js'
import { createMcpStep, mcpRemovals } from './mcp-config.js'
import { queueDirectory, queueDirRemoval } from './queue-dir.js'
import { createDeregisterStep, createRegisterStep } from './register.js'
import { createRulesStep, rulesRemovals } from './rules.js'
import type { Result } from './run.js'

/**
 * The engine behind `dogear init` — E1 (#26).
 *
 * ./init.ts resolves the repository and hands off here; this file decides what a repo is
 * missing and puts it there. The split is ./mcp.ts → ./server.js, for the same reason: the
 * adapter stays free of everything the implementation imports, so `dogear hook` — which runs
 * on every prompt the user types, under the 2s budget asserted in
 * ../test-built/hook.test.ts — never loads it.
 *
 * ---
 *
 * **The `Step` seam is the actual deliverable of E1**, and the reason #26 blocks four other
 * issues. E4 (#29) added the config file and the gitignore rules; E3 (#28) added agent wiring —
 * each an entry in {@link stepsFor}, in a module of its own, not a change to the runner. Three
 * properties make that work, and none of them survives casual editing:
 *
 * 1. **`plan()` never writes.** It inspects and returns a description of what it *would* do.
 *    This is what E2's `--dry-run` is built on: plan every step, print the lot, apply nothing.
 *    A step that writes during planning makes that flag a lie, and the lie is invisible on a
 *    fresh repo — the run that was meant to change nothing looks identical to one that did.
 * 2. **Idempotency is the absence of a code path, not the presence of one.** `plan()` returns
 *    `undefined` when the repo is already correct, and that is the whole mechanism. There is
 *    no `alreadyInitialized()` predicate to keep in sync with the thing it predicts — a step
 *    that cannot tell whether it has run is a step that cannot be added here.
 * 3. **The summary is past tense and user-facing**, because it is printed only after `apply()`
 *    returned. `'created .dogear/'`, not `'create .dogear/'` — a report of what changed, which
 *    is the third acceptance criterion, rather than a plan of what might.
 *
 * **Apply stops at the first failure.** The alternative — carry on and collect errors — buys a
 * little more done per invocation and costs the property that matters more: cascading failures
 * from one root cause are much harder to read than the root cause alone, and by E3 a run has
 * six steps to cascade through. What did land is still reported, so a re-run picks up exactly
 * where this one stopped. That is the same idempotency as above doing a second job.
 *
 * E3's ordering leans on it in one direction worth naming: the MCP registration is the baseline
 * and comes before the prompt hook, so a failure part-way leaves the half that carries the
 * whole feature set done. Each of E3's steps creates its own parent directory, so none of them
 * depends on an earlier one having run.
 *
 * **Every `plan()` runs before any `apply()`** — which is what `--dry-run` needs, and which
 * makes "planning never throws" a hard rule rather than a style note. A step inspects a
 * repository that the steps above it have *not* repaired yet, so ./config.ts stats
 * `.dogear/config.json` in a repo where `.dogear` is a regular file and gets `ENOTDIR`.
 * Unhandled, that turns a clean report from the step that found the real problem into a stack
 * trace from the step that merely tripped over it.
 *
 * ---
 *
 * **E2 (#27) added detection, and it is a phase rather than a step.** This header used to say
 * E2 would prepend one; it was wrong, and the correction is worth keeping. A step's only voice
 * is `Plan.notes`, and notes print *below* the change list — so detection-as-a-step would have
 * reported what it found after init had already changed things, which is the inversion of
 * #27's second acceptance criterion. ./detect.ts runs first, its findings get a section of
 * their own above the changes, and the result reaches every `plan()` as a second argument. A
 * step that ignores that argument simply declares `plan: (root) => …` and is unaffected, which
 * is why E4's three steps needed no edit.
 *
 * **E3 (#28) wanted it one level earlier than that**, and the correction is worth keeping too.
 * This header predicted E3 would read `plan()`'s second argument; it reads it not at all. Its
 * three steps need detection **reconciled with `--agent` and `--no-hook`** before they can say
 * what they would do, and folding a flag into `Detection` would make the `agent:` findings line
 * report a preference as an observation. So they are built per run from a {@link Wiring} — see
 * {@link resolveWiring} and {@link stepsFor}. The second argument still earns its place: it is
 * what lets a step read the repository without a second traversal, which E5 or E6 may want even
 * though E3 did not.
 *
 * **E4 widened `plan()` to return notes as well as a change**, and the reason is that some of
 * what init has to say is not something it did. A `.gitignore` that already excludes
 * `config.json`, or a `queue.json` git is already tracking, are both facts init can report and
 * must not silently "fix" — and a {@link Change} cannot carry either, because a change is a
 * line printed *after* `apply()` returned, and there is nothing to apply. E2's detection
 * report and E6's "a queue with pending annotations is reported, not deleted" want the same
 * shape, so the widening happened at the first ticket that needed it rather than being
 * designed for three.
 */

/** A single change to the repository, produced by planning and printed after applying. */
export interface Change {
  /**
   * One line, past tense, for the report: `created .dogear/`. Read by a human immediately
   * after the change happened, so it describes a fact rather than an intention.
   */
  readonly summary: string
  /** Performs the change. Throwing is how a step reports failure; see {@link scaffold}. */
  readonly apply: () => void
}

/** What one step found: something to do, something to say, or both. */
export interface Plan {
  /** The change to make. Absent when the repository already satisfies the step. */
  readonly change?: Change
  /**
   * Facts the user should know that init is not going to act on — printed after the
   * changes, one `note:` line each.
   *
   * A note is **not** a failure and never affects the exit code. It exists for the state
   * init can see, cannot repair without guessing at intent, and must not leave unsaid:
   * see ./gitignore.ts, which has both of the examples that motivated it.
   */
  readonly notes?: readonly string[]
}

/** One thing `dogear init` is responsible for. E3 adds an entry to {@link STEPS}. */
export interface Step {
  /** Internal, for diagnostics. The user reads {@link Change.summary} instead. */
  readonly name: string
  /**
   * Inspect the repository. **Never writes, and never throws** — see the header.
   *
   * Returns `undefined` when the repo already satisfies this step and there is nothing to
   * report, which is what makes re-running report nothing.
   *
   * `detection` is E2's (#27) findings, already gathered. A step that does not need them
   * declares `plan: (root) => …` and TypeScript accepts it — which is the point of a second
   * parameter rather than a context object, since none of E4's three steps has any use for it.
   */
  readonly plan: (root: string, detection: Detection) => Plan | undefined
}

/**
 * One thing `dogear init --undo` takes back out — E6 (#39).
 *
 * **A second list rather than a `revert` beside `plan`**, and #39 left the choice open on the
 * grounds that a `revert` "avoids burdening E2's detection, which writes nothing". That
 * argument had expired by the time this was picked up: E2 settled detection as a *phase* and
 * E8 did the same for its guidance block, so every member of {@link stepsFor} is a real writer
 * and none of them would have been burdened.
 *
 * What decided it instead is {@link Wiring}. `stepsFor` picks its MCP targets from resolved
 * detection, so a `revert` hanging off one of those objects would carry a wiring it must be
 * documented never to consult — because undo has to scan **all three** agent configs
 * unconditionally. Init with `--agent=cursor`, delete `.cursor/`, and detection now says
 * `claude`; a wiring-driven undo would walk straight past `.cursor/mcp.json` and leave the
 * entry that #39 exists to remove. A separate list has no wiring to ignore, and needs no change
 * to {@link Step}, {@link Plan}, {@link Change} or the report.
 *
 * The cost is that nothing makes the compiler demand a teardown for a new step. ./scaffold.test.ts
 * pins it instead, by matching every {@link Step} name against an entry in {@link UNDO_STEPS}.
 */
export interface Undo {
  /** Matches the {@link Step} it reverses, which is what ./scaffold.test.ts pairs them on. */
  readonly name: string
  /**
   * Inspect the repository. **Never writes, and never throws** — the same contract as
   * {@link Step.plan}, for the same reason: `--undo --dry-run` plans everything and applies
   * nothing.
   *
   * No `detection` argument, because an undo run never calls `detect()`. Detection answers
   * *what should be wired here*, and every line of it — the `vite:` findings, the JSX-only
   * remark, E8's install block — describes a repository being set up rather than one being
   * taken apart.
   */
  readonly plan: (root: string) => Plan | undefined
}

/** How `dogear init` was asked to run. */
export interface ScaffoldOptions {
  /**
   * Plan and report, change nothing — E2's (#27) report-before-change, in the form a
   * non-interactive command can take.
   *
   * This is the abort path: the findings and the would-be changes are exactly what a real run
   * would produce, so a detection that guessed wrong is visible before anything is written.
   */
  readonly dryRun?: boolean
  /**
   * `--agent`, if it was given at all — E3 (#28).
   *
   * **Replaces what detection found rather than adding to it.** Repeat the flag for several.
   * An empty array is `--agent=none` and is not the same as `undefined`: the first says wire
   * nothing, the second says nobody expressed a preference, so use the markers.
   *
   * Subtraction is why it replaces. A user whose repository has a `.cursor/` they do not want
   * touched has no way to say so under a union, and a second flag to express it would be a
   * worse interface than one flag that means what it says.
   */
  readonly agents?: readonly Agent[]
  /**
   * `--no-hook` — E3 (#28). Defaults to true where Claude Code is among the agents.
   *
   * Declining leaves a **fully working install**, which is the acceptance criterion and also
   * the architecture: MCP carries the whole feature set and the hook only removes the need to
   * ask for it.
   */
  readonly hook?: boolean
}

/**
 * How `dogear init --undo` was asked to run — E6 (#39).
 *
 * Only `dryRun`, and that is the whole point: `--agent` and `--no-hook` select what to *wire*,
 * so ./init.ts refuses them here rather than letting this type quietly ignore them. Someone who
 * typed `--undo --agent=cursor` believes they asked for something narrower than what undo does.
 */
export interface UndoOptions {
  readonly dryRun?: boolean
}

/**
 * What `dogear init` resolved to wire, once flags and detection have been reconciled — E3 (#28).
 *
 * Passed to the three agent steps at construction rather than reaching them through `plan()`'s
 * `detection` argument, and the distinction is not cosmetic: `Detection` is *what is true of
 * the repository*, and folding a flag into it would make the `agent:` findings line report a
 * preference as an observation. The steps are built per run — see {@link stepsFor} — which is
 * the same factory shape ./gitignore.ts already uses for its injected `GitQueries`.
 */
export interface Wiring {
  /** Resolved targets, in marker order. Empty means wire nothing. */
  readonly agents: readonly Agent[]
  /** Whether to write Claude Code's prompt hook. */
  readonly hook: boolean
  /** Whether `dogear-cli` resolves from inside the repo, for the registration's note. */
  readonly cli: Cli
}

/**
 * Flags over detection, with one default that is not a detection at all.
 *
 * **A repository with no marker still gets `.mcp.json`.** `mcpServers` at the repository root
 * is the closest thing to a portable default — Claude Code reads it, and so does a growing set
 * of other clients — and "every agent gets the MCP server registered" cannot be the baseline
 * path if the commonest case, a fresh clone nobody has opened in an editor yet, gets nothing at
 * all. The `agent:` findings line still says `none detected`, so the report never claims to
 * have seen something it did not.
 *
 * `--agent=none` is the way to mean *nothing*, and it survives this: an explicit empty array is
 * honoured, only an absent one defaults.
 */
export function resolveWiring(detection: Detection, options: ScaffoldOptions): Wiring {
  const detected = detection.agents.map((entry) => entry.agent)
  const chosen =
    options.agents ?? (detected.length === 0 ? ['claude' as const] : detected)

  return {
    agents: chosen,
    hook: options.hook ?? true,
    cli: detection.cli,
  }
}

/**
 * Run in order. Detection is not here, it is a phase — see the header.
 *
 * The directory comes first because ./config.ts writes a file inside it and `apply` stops at
 * the first failure — a config step that ran first would fail with `ENOENT` on a fresh repo
 * and report that instead of creating anything. `.gitignore` is independent of everything and
 * goes last, which is also the order the brief's install sequence describes.
 *
 * **E3's three sit between them, built per run rather than declared as constants**, because
 * they need the resolved {@link Wiring} and a module-level constant could not have it. Their
 * own order is the brief's Delivery ordering made literal: the MCP registration is the baseline
 * and comes first, the stanza that makes a pull-based server actually get pulled comes next,
 * and the prompt hook — the tier on top, and the only one `--no-hook` removes — comes last. A
 * failure part-way therefore leaves the more important half done.
 *
 * **E5's (#30) registry step is last of all**, after `.gitignore`, because it is the only step
 * whose work is not part of the feature: every other one contributes to annotations reaching an
 * agent, while this one tells `dogear status` the repository exists. It is also the only step
 * that writes outside the repository, which is the second reason to run it once everything
 * inside is done. That matches the brief's install sequence, where registering is step 7.
 */
export function stepsFor(wiring: Wiring): readonly Step[] {
  return [
    queueDirectory,
    configFile,
    createMcpStep(wiring),
    createRulesStep(wiring),
    createHookStep(wiring),
    gitignore,
    // `process.env` reaches the step here rather than through {@link ScaffoldOptions}, because
    // the only thing it carries is `DOGEAR_HOME` and the only caller that wants a different one
    // is a test — which sets the variable itself through `isolateRegistry()`, exactly as the
    // suites that need git to see no configuration go through `isolateGitConfig()`. An option
    // nothing but a test would ever pass is API that exists to be mocked.
    createRegisterStep(process.env),
  ]
}

/**
 * The reverse — E6 (#39). Not `stepsFor` read backwards, and the difference is the ticket.
 *
 * **The prompt hook comes out first and always.** Every other residue is inert: a leftover
 * `.mcp.json` entry costs a server the client fails to spawn once per session, and a leftover
 * `.gitignore` rule costs a line. An orphaned `UserPromptSubmit` entry runs `node <path> hook`
 * against a path that no longer exists **on every prompt the user types**, which is the only
 * thing here that breaks something, and it breaks it in a tool the user believes they have
 * removed. So it goes before anything that could fail — `apply` stops at the first failure, and
 * the ordering rule init already follows (leave the important half done) inverts under teardown
 * into *take the dangerous half out first*.
 *
 * The rest follows the same inversion. `.dogear/config.json` must go before `.dogear/`, because
 * the directory is only removed once it is empty. The registry is last for the reason it is
 * last on the way in: it is the only entry that writes outside the repository, and there is
 * nothing to be gained by forgetting a repository whose teardown then fails half way.
 *
 * `process.env` reaches ./register.ts's factory here for the reason {@link stepsFor} gives.
 */
const UNDO_STEPS: readonly Undo[] = [
  hookRemoval,
  // Several entries each, one per file they touch, so a repository where one config is deleted
  // whole and another is spliced gets a correctly-verbed line for each. See ./mcp-config.ts.
  ...mcpRemovals,
  ...rulesRemovals,
  gitignoreRemoval,
  configRemoval,
  queueDirRemoval,
  createDeregisterStep(process.env),
]

/** Exposed for ./scaffold.test.ts, which pairs these against {@link stepsFor} by name. */
export function undoSteps(): readonly Undo[] {
  return UNDO_STEPS
}

/**
 * Bring `root` up to date, and report what that took.
 *
 * Returns a {@link Result} rather than writing anything, which keeps every byte this command
 * produces assertable in the fast suite — the same reason ./emit.ts exists. ./init.ts is what
 * turns it into bytes.
 *
 * The header line names the resolved root on purpose. `init` walks up for the git root, so the
 * directory it operates on is frequently not the one the user is standing in, and a monorepo
 * user running this from a package subdirectory should be able to see that at a glance rather
 * than discovering it when the queue turns up somewhere unexpected.
 */
export function scaffold(root: string, options: ScaffoldOptions = {}): Result {
  // First, and before anything is planned: #27's criterion is that init says what it found
  // *before* it changes anything, and a phase that ran after the steps could not.
  const detection = detect(root)
  const findings = describe(detection)

  // Flags reconciled against detection before anything plans — E3 (#28). The three agent steps
  // are constructed from the result, so what they do is fixed before the first `plan()` runs.
  const wiring = resolveWiring(detection, options)

  // Every step plans before any step applies. See the header — this is what `--dry-run` is
  // built on, and why `plan()` may not throw.
  const plans = stepsFor(wiring)
    .map((step) => step.plan(root, detection))
    .filter((plan): plan is Plan => plan !== undefined)

  // Kept apart from the step notes all the way to the report, and not for ordering: only step
  // notes suppress `nothing changed`. See {@link report}.
  const found = remarks(detection, wiring)
  // E8 (#41)'s trailing block — what init is telling the user to do rather than doing. Beside
  // `remarks` for the same reason it is not a step: nothing plans it and nothing applies it.
  const next = guidance(detection)
  const notes = plans.flatMap((plan) => plan.notes ?? [])
  const { applied, failure } = applyAll(plans, options.dryRun === true)

  return {
    output: report({
      root,
      findings,
      applied,
      notes,
      found,
      // E8's block is withheld on a failure, and this is the only place it is. It tells the
      // user to install a plugin into a repository init could not finish setting up; what they
      // should do next is fix what failed and re-run, and the re-run prints it.
      next: failure === undefined ? next : [],
      dryRun: options.dryRun === true,
      failure,
    }),
    exitCode: failure === undefined ? 0 : 1,
  }
}

/**
 * Take back out what {@link scaffold} put in, and report what that removed — E6 (#39).
 *
 * The mirror of `scaffold`, and deliberately the *smaller* function: no detection phase, no
 * `remarks()`, no E8 guidance block. All three describe a repository being set up. See
 * {@link Undo} for why undo is a list of its own rather than a `revert` on each `Step`, and
 * {@link UNDO_STEPS} for why its order is not `stepsFor` reversed.
 *
 * **Refusing outside a git repository is ./init.ts's, not this function's** — `--undo` is a
 * flag on `init`, so it reaches the same synchronous check before anything here runs. That is
 * most of the argument for it being a flag rather than a command of its own.
 *
 * A repository that was never init'd plans nothing, reports `nothing changed` and exits 0,
 * which falls straight out of `plan()` returning `undefined` — the same mechanism that makes
 * re-running `init` a no-op, doing its second job.
 */
export function unscaffold(root: string, options: UndoOptions = {}): Result {
  const plans = UNDO_STEPS.map((step) => step.plan(root)).filter(
    (plan): plan is Plan => plan !== undefined,
  )

  const notes = plans.flatMap((plan) => plan.notes ?? [])
  const { applied, failure } = applyAll(plans, options.dryRun === true)

  return {
    output: report({
      root,
      findings: [],
      applied,
      notes,
      found: [],
      next: [],
      dryRun: options.dryRun === true,
      failure,
    }),
    exitCode: failure === undefined ? 0 : 1,
  }
}

/**
 * Apply what was planned, or say what it would have done — shared by both runners.
 *
 * **Stops at the first failure**, and `applied` holds only what actually happened, so the
 * report stays true and a re-run resumes from there rather than repeating what already
 * succeeded. See the header for why collecting errors was rejected.
 */
function applyAll(
  plans: readonly Plan[],
  dryRun: boolean,
): { readonly applied: readonly string[]; readonly failure?: string } {
  const applied: string[] = []

  for (const { change } of plans) {
    if (change === undefined) continue

    // Past tense is {@link Change.summary}'s contract, and a dry run is the one caller that
    // cannot honour it. Converting here rather than giving every step a second tense to keep
    // in sync is the cheaper half of that trade — one call site bends, instead of every step
    // carrying a string it uses on one run in a hundred.
    if (dryRun) {
      applied.push(`would ${imperative(change.summary)}`)
      continue
    }

    try {
      change.apply()
    } catch (error) {
      return { applied, failure: `failed: ${messageOf(error)}` }
    }

    applied.push(change.summary)
  }

  return { applied }
}

/**
 * The report: what was found, then what changed, then what was worth saying.
 *
 * Listing every step with an `ok`/`created` marker was the alternative and is a different
 * command: #26 asks for a re-run that "reports only what changed", and by E4 a per-step
 * checklist would print six lines every time to say that six things were already true.
 *
 * **Findings come first and do not suppress `nothing changed`** — unlike notes. They describe
 * the repository rather than the run, so they print on every invocation, including one that
 * changed nothing; and `nothing changed` under them is still true and still worth saying,
 * because it is the only line that answers the question the user actually asked. That is also
 * why they are labelled `vite:` and `workspace:` rather than written as sentences: the eye
 * separates them from the past-tense change lines without needing a section header.
 *
 * **Step notes come last and suppress `nothing changed`.** They are not changes, so they are
 * not mixed in among them; and a report reading `nothing changed` directly above a note saying
 * the queue is being committed would be a summary contradicting its own body. A run with
 * notes and no changes prints only the notes, which is the honest form of "nothing changed,
 * but look at this".
 *
 * **Detection's remarks do not suppress it, though they print in the same form**, and the
 * distinction is E2's, discovered by the built-binary suite rather than designed: a repository
 * with no Vite config earns a remark on *every* run, so folding those in would mean that the
 * commonest reason to run init twice is also the case where init never gives a verdict. A step
 * note qualifies what init did or declined to do; a remark describes the repository, which is
 * what the findings above already do without silencing anything.
 */
function report(run: {
  readonly root: string
  readonly findings: readonly string[]
  readonly applied: readonly string[]
  readonly notes: readonly string[]
  readonly found: readonly string[]
  readonly next: readonly string[]
  readonly dryRun?: boolean
  readonly failure?: string
}): string {
  const { root, findings, applied, notes, found, next, dryRun, failure } = run
  const unremarkable = applied.length === 0 && notes.length === 0 && failure === undefined

  const body = [
    `dogear: ${root}`,
    // Above the findings, not below them: it changes what every line after it means, and a
    // caveat printed after the thing it qualifies has already been misread.
    ...(dryRun === true ? ['dry run — nothing was written'] : []),
    ...findings,
    ...(unremarkable ? ['nothing changed'] : applied),
    ...(failure === undefined ? [] : [failure]),
    ...[...notes, ...found].map((note) => `note: ${note}`),
  ].map((line, index) => (index === 0 ? line : `  ${line}`))

  // E8's (#41) block is appended *outside* the indent, and that is not cosmetic: the two-space
  // indent belongs to the report's one-line-per-item body, and a code snippet the user is meant
  // to copy has an indent of its own that the body's would silently corrupt. It carries its own
  // leading blank line, so an empty block adds nothing at all.
  return [...body, ...next].join('\n')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The past-tense verbs steps use, and what a dry run calls them instead.
 *
 * **A table rather than a rule**, because there isn't one: `created` → `create` is regular and
 * `wrote` → `write` is not, and a step is free to describe itself either way. It is small
 * because the vocabulary is — every step so far reports doing one of these things to one path.
 * A step E3 adds with a verb that is not here renders unchanged, which reads as `would created`
 * and is caught by ./scaffold.test.ts rather than shipping as a typo.
 */
const IMPERATIVE = new Map([
  ['created', 'create'],
  ['updated', 'update'],
  ['merged', 'merge'],
  ['added', 'add'],
  ['wrote', 'write'],
  ['registered', 'register'],
  // E6 (#39)'s two teardown verbs, and they are not interchangeable. `deleted` means a whole
  // file or directory is gone; `removed` means bytes were spliced out of one that stays. Undo
  // can do either to `.mcp.json`, and the user has to be able to tell which happened at a
  // glance — so the split is the report's, not a matter of taste, and every `Undo` keeps to it.
  ['removed', 'remove'],
  ['deleted', 'delete'],
])

/** `created .dogear/` → `create .dogear/`, for the one caller that has not done it yet. */
function imperative(summary: string): string {
  const end = summary.indexOf(' ')
  const verb = end === -1 ? summary : summary.slice(0, end)
  const replacement = IMPERATIVE.get(verb)

  return replacement === undefined
    ? summary
    : `${replacement}${summary.slice(verb.length)}`
}

/** How many apps the report names before it gives up and counts the rest. */
const APP_CAP = 5

/** Column width for the finding labels, so `vite:` and `framework:` line their values up. */
const LABEL_WIDTH = 'framework:'.length + 1

/**
 * The findings, as report lines — E2 (#27), and the whole of its first acceptance criterion.
 *
 * All the rendering lives here rather than in ./detect.ts, which returns structured data: E3
 * (#28) consumes the same value to decide what to wire, and a detector that returned prose
 * would have to be parsed back apart to be useful to anything but this function.
 */
function describe(detection: Detection): readonly string[] {
  const { workspace, packages, apps } = detection

  const layout =
    workspace === 'single'
      ? 'single package'
      : `${workspace} workspaces${count(packages)}`

  return [
    ...(apps.length <= 1 ? single(apps[0]) : many(apps)),
    label('workspace', `${layout}, ${plural(apps.length, 'app')}`),
    label('agent', agents(detection)),
  ]
}

/** Display names, so the report says `claude code` rather than the internal `claude`. */
const AGENT_NAMES: Record<Agent, string> = {
  claude: 'claude code',
  cursor: 'cursor',
  vscode: 'vs code',
}

/**
 * What detection made of the repository's tooling — E3 (#28).
 *
 * **Names the marker, not just the conclusion.** Every change this ticket makes follows from
 * this one line, and a `--dry-run` whose whole purpose is to let a wrong guess be caught before
 * it is written has to show its working. `none detected` is an ordinary answer rather than a
 * warning: `.mcp.json` is still written, because it is the portable default — see
 * {@link resolveWiring}.
 */
function agents(detection: Detection): string {
  if (detection.agents.length === 0) return 'none detected'

  return detection.agents
    .map((entry) => `${AGENT_NAMES[entry.agent]} (${entry.marker})`)
    .join(', ')
}

/** No app, or exactly one: the config and the framework each get a line of their own. */
function single(app: DetectedApp | undefined): readonly string[] {
  if (app === undefined) return [label('vite', 'none found')]

  return [
    label(
      'vite',
      `${app.config}${app.viteVersion === undefined ? '' : ` (vite ${app.viteVersion})`}`,
    ),
    label('framework', versioned(app) ?? 'none detected'),
  ]
}

/**
 * Two or more: one line each, capped.
 *
 * Capped rather than aggregated because frameworks differ between apps in one repository, and
 * "3 apps" would hide the Vue app sitting beside two React ones — which is the difference
 * between a stamped source location and the selector floor. Capped rather than exhaustive
 * because a thirty-package monorepo would otherwise print thirty lines above the three that
 * say what init did.
 */
function many(apps: readonly DetectedApp[]): readonly string[] {
  const shown = apps.slice(0, APP_CAP).map((app) => {
    const where = app.dir === '' ? '.' : app.dir
    return `${where} — ${versioned(app) ?? 'no framework detected'} (${basename(app.config)})`
  })

  const hidden = apps.length - shown.length
  const lines = hidden === 0 ? shown : [...shown, `+ ${plural(hidden, 'more app')}`]

  return lines.map((line, index) => (index === 0 ? label('apps', line) : indent(line)))
}

/**
 * What detection saw and init will not act on — the `note:` half of E2.
 *
 * Emitted by the runner rather than by a step, because nothing plans them: there is no change
 * to make and nothing to become idempotent about. Both are the shape `Plan.notes` was widened
 * for in E4 — state init can see, must not repair by guessing, and must not leave unsaid.
 */
function remarks(detection: Detection, wiring: Wiring): readonly string[] {
  if (detection.apps.length === 0) {
    return [...cliNotInstalled(wiring), ...noViteConfig()]
  }

  // React, Preact and Solid all author components in `.jsx`/`.tsx`, which is what the
  // transform's default `include` matches, so all three are stamped. Vue and Svelte are not,
  // and an app whose framework detection came back empty is not something to warn about — we
  // do not know that it is unsupported, only that we could not tell.
  const floored = detection.apps.filter(
    (app) => app.framework === 'vue' || app.framework === 'svelte',
  )

  return [
    ...cliNotInstalled(wiring),
    ...jsxOnly(floored),
    ...runtimeDependency(detection.apps),
  ]
}

function noViteConfig(): readonly string[] {
  return [
    'no vite config found. dogear is a Vite dev-server plugin — the overlay will not ' +
      'load without one.',
  ]
}

/**
 * The local `dogear-cli` the committed configs point at — G3 (#44).
 *
 * **A remark rather than a step note, and the round trip is the interesting part.** E3 had
 * ./mcp-config.ts note it, gated on a registration being *written* — so it fired once, on the
 * run that created `.mcp.json`, and never again. G3 walked the documented install path and
 * found the consequence: a repository reporting `nothing changed` over an MCP server that
 * exited 1 on spawn and a `UserPromptSubmit` hook that failed on every prompt the user typed.
 *
 * Moving the condition to "a registration exists" fixed the firing and broke something else —
 * step notes suppress `nothing changed`, so a repository that earns this on every run never
 * got a verdict again, which is exactly the trap {@link report} describes for E2's remarks.
 * The discriminator there settles it: *a step note qualifies what init did or declined to do;
 * a remark describes the repository.* Init did not decline anything — it wrote the
 * registration, correctly. What is wrong is the repository, and it stays wrong until someone
 * installs the package. So it belongs here, where it prints every run and silences nothing.
 *
 * It speaks for the **prompt hook** as well: ./hook-config.ts writes the same `CLI_ENTRY` and
 * had no warning of its own, and that is the worse failure of the two. An MCP server that will
 * not start is silent until a tool is called; a hook pointing at a missing file is not.
 */
function cliNotInstalled(wiring: Wiring): readonly string[] {
  // Nothing names `CLI_ENTRY` when nothing is wired, so there is nothing to warn about.
  if (wiring.agents.length === 0 || wiring.cli === 'local') return []

  const surfaces =
    wiring.hook && wiring.agents.includes('claude')
      ? 'the MCP registration and the prompt hook both point'
      : 'the MCP registration points'

  return [
    `${surfaces} at ${CLI_ENTRY}, which is not installed here. Run ` +
      '`npm i -D dogear-cli` so the path resolves for everyone who clones this repository.',
  ]
}

/** brief:1517 — the transform is JSX-only, so these apps get the selector floor and no more. */
function jsxOnly(floored: readonly DetectedApp[]): readonly string[] {
  if (floored.length === 0) return []

  const named = floored
    .slice(0, APP_CAP)
    .map((app) => `${app.dir === '' ? '.' : app.dir} (${app.framework})`)
    .join(', ')

  return [
    `${named} — dogear's source transform is JSX-only, so annotations there fall back to ` +
      'the CSS-selector and text floor.',
  ]
}

/**
 * `dogear-vite` in `dependencies` rather than `devDependencies` — E8 (#41).
 *
 * **Reported, never moved.** This is the manifest half of the leak `scripts/check-leak.ts`
 * exists to catch: a dev-only plugin in `dependencies` installs in production even when every
 * bundle is clean, so it is worth saying. Moving it is a different act — an edit to a choice
 * the user made, whose reason init cannot see — and it is the same line E4's gitignore step
 * already declines to cross with `!.dogear/config.json`.
 */
function runtimeDependency(apps: readonly DetectedApp[]): readonly string[] {
  const wrong = apps.filter((app) => app.plugin === 'runtime')
  if (wrong.length === 0) return []

  const named = [...new Set(wrong.map((app) => manifestOf(app)))]
    .slice(0, APP_CAP)
    .join(', ')

  return [
    `dogear-vite is a runtime dependency in ${named}. It is dev-only — move it to ` +
      'devDependencies so it cannot install in production.',
  ]
}

/** The package a `runtime` declaration is actually in, which may not be the app's directory. */
function manifestOf(app: DetectedApp): string {
  const dir = app.manifestDir
  return dir === undefined || dir === '' ? 'the root package.json' : `${dir}/package.json`
}

/** `framework: react ^19.2.0`, padded so the values align. */
function label(name: string, value: string): string {
  return `${`${name}:`.padEnd(LABEL_WIDTH)}${value}`
}

/** A continuation line under a label, aligned with the values above it. */
function indent(value: string): string {
  return `${' '.repeat(LABEL_WIDTH)}${value}`
}

function versioned(app: DetectedApp): string | undefined {
  if (app.framework === undefined) return undefined
  return app.frameworkVersion === undefined
    ? app.framework
    : `${app.framework} ${app.frameworkVersion}`
}

/** `, 5 packages`, or nothing at all when the count is unknown — see {@link Detection.packages}. */
function count(packages: number | undefined): string {
  return packages === undefined ? '' : `, ${plural(packages, 'package')}`
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
