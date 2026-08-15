import { configFile } from './config.js'
import type { Detection, DetectedApp } from './detect.js'
import { detect } from './detect.js'
import { gitignore } from './gitignore.js'
import { queueDirectory } from './queue-dir.js'
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
 * issues. E4 (#29) added the config file and the gitignore rules; E3 (#28) adds agent wiring —
 * each an entry appended to {@link STEPS}, in a module of its own, not a change to the runner.
 * Three properties make that work, and none of them survives casual editing:
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
 * little more done per invocation and costs the property that matters more: by E3, a step that
 * merges `.claude/settings.json` runs after a step that created the directory it writes into,
 * and cascading failures from one root cause are much harder to read than the root cause
 * alone. What did land is still reported, so a re-run picks up exactly where this one stopped.
 * That is the same idempotency as above doing a second job.
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
 * their own above the changes, and the result reaches every `plan()` as a second argument so
 * E3 can wire what detection saw rather than looking again. A step that ignores that argument
 * simply declares `plan: (root) => …` and is unaffected, which is why E4's three steps needed
 * no edit.
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
}

/**
 * Run in order. E3 appends agent wiring; detection is not here, it is a phase — see the header.
 *
 * The directory comes first because ./config.ts writes a file inside it and `apply` stops at
 * the first failure — a config step that ran first would fail with `ENOENT` on a fresh repo
 * and report that instead of creating anything. `.gitignore` is independent of both and goes
 * last, which is also the order the brief's install sequence describes.
 */
const STEPS: readonly Step[] = [queueDirectory, configFile, gitignore]

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

  // Every step plans before any step applies. See the header — this is what `--dry-run` is
  // built on, and why `plan()` may not throw.
  const plans = STEPS.map((step) => step.plan(root, detection)).filter(
    (plan): plan is Plan => plan !== undefined,
  )

  // Kept apart from the step notes all the way to the report, and not for ordering: only step
  // notes suppress `nothing changed`. See {@link report}.
  const found = remarks(detection)
  const notes = plans.flatMap((plan) => plan.notes ?? [])
  const applied: string[] = []

  for (const { change } of plans) {
    if (change === undefined) continue

    // Past tense is {@link Change.summary}'s contract, and a dry run is the one caller that
    // cannot honour it. Converting here rather than giving every step a second tense to keep
    // in sync is the cheaper half of that trade — one call site bends, instead of every step
    // carrying a string it uses on one run in a hundred.
    if (options.dryRun === true) {
      applied.push(`would ${imperative(change.summary)}`)
      continue
    }

    try {
      change.apply()
    } catch (error) {
      // Stop here. `applied` holds only what actually happened, so the report stays true and
      // a re-run resumes from this step rather than repeating the ones above it.
      //
      // The notes still go out. They describe what was already true of the repository, so a
      // failure part-way through makes none of them less true — and the one about a tracked
      // queue.json is exactly what someone re-running a failed init needs to know.
      return {
        output: report({
          root,
          findings,
          applied,
          notes,
          found,
          failure: `failed: ${messageOf(error)}`,
        }),
        exitCode: 1,
      }
    }

    applied.push(change.summary)
  }

  return {
    output: report({
      root,
      findings,
      applied,
      notes,
      found,
      dryRun: options.dryRun === true,
    }),
    exitCode: 0,
  }
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
  readonly dryRun?: boolean
  readonly failure?: string
}): string {
  const { root, findings, applied, notes, found, dryRun, failure } = run
  const unremarkable = applied.length === 0 && notes.length === 0 && failure === undefined

  return [
    `dogear: ${root}`,
    // Above the findings, not below them: it changes what every line after it means, and a
    // caveat printed after the thing it qualifies has already been misread.
    ...(dryRun === true ? ['dry run — nothing was written'] : []),
    ...findings,
    ...(unremarkable ? ['nothing changed'] : applied),
    ...(failure === undefined ? [] : [failure]),
    ...[...notes, ...found].map((note) => `note: ${note}`),
  ]
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n')
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
  ]
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
function remarks(detection: Detection): readonly string[] {
  if (detection.apps.length === 0) {
    return [
      'no vite config found. dogear is a Vite dev-server plugin — the overlay will not ' +
        'load without one.',
    ]
  }

  // React, Preact and Solid all author components in `.jsx`/`.tsx`, which is what the
  // transform's default `include` matches, so all three are stamped. Vue and Svelte are not,
  // and an app whose framework detection came back empty is not something to warn about — we
  // do not know that it is unsupported, only that we could not tell.
  const floored = detection.apps.filter(
    (app) => app.framework === 'vue' || app.framework === 'svelte',
  )
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
