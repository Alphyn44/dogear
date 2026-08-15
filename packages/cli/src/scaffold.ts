import { configFile } from './config.js'
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
 * issues. E4 (#29) added the config file and the gitignore rules; E2 (#27) adds detection and
 * E3 (#28) agent wiring — each an entry appended to {@link STEPS}, in a module of its own, not
 * a change to the runner. Three properties make that work, and none of them survives casual
 * editing:
 *
 * 1. **`plan()` never writes.** It inspects and returns a description of what it *would* do.
 *    This is what E2's acceptance criterion — report what was found *before changing
 *    anything* — is built on: plan every step, print the lot, then apply. A step that writes
 *    during planning makes that report a lie, and the lie is invisible on a fresh repo.
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
 * **Every `plan()` runs before any `apply()`** — which is what the report-before-change
 * criterion needs, and which makes "planning never throws" a hard rule rather than a style
 * note. A step inspects a repository that the steps above it have *not* repaired yet, so
 * ./config.ts stats `.dogear/config.json` in a repo where `.dogear` is a regular file and gets
 * `ENOTDIR`. Unhandled, that turns a clean report from the step that found the real problem
 * into a stack trace from the step that merely tripped over it.
 *
 * ---
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

/** One thing `dogear init` is responsible for. E2 and E3 each add entries to {@link STEPS}. */
export interface Step {
  /** Internal, for diagnostics. The user reads {@link Change.summary} instead. */
  readonly name: string
  /**
   * Inspect the repository. **Never writes, and never throws** — see the header.
   *
   * Returns `undefined` when the repo already satisfies this step and there is nothing to
   * report, which is what makes re-running report nothing.
   */
  readonly plan: (root: string) => Plan | undefined
}

/**
 * Run in order. E2 prepends detection; E3 appends agent wiring.
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
export function scaffold(root: string): Result {
  // Every step plans before any step applies. See the header — this is what E2's
  // report-before-change is built on, and why `plan()` may not throw.
  const plans = STEPS.map((step) => step.plan(root)).filter(
    (plan): plan is Plan => plan !== undefined,
  )

  const notes = plans.flatMap((plan) => plan.notes ?? [])
  const applied: string[] = []

  for (const { change } of plans) {
    if (change === undefined) continue

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
        output: report(root, applied, notes, `failed: ${messageOf(error)}`),
        exitCode: 1,
      }
    }

    applied.push(change.summary)
  }

  return { output: report(root, applied, notes), exitCode: 0 }
}

/**
 * The report. Changes only — an unchanged repo prints `nothing changed` and nothing else.
 *
 * Listing every step with an `ok`/`created` marker was the alternative and is a different
 * command: #26 asks for a re-run that "reports only what changed", and by E4 a per-step
 * checklist would print six lines every time to say that six things were already true.
 *
 * **Notes come last and suppress `nothing changed`.** They are not changes, so they are not
 * mixed in among them; and a report reading `nothing changed` directly above a note saying
 * the queue is being committed would be a summary contradicting its own body. A run with
 * notes and no changes prints only the notes, which is the honest form of "nothing changed,
 * but look at this".
 */
function report(
  root: string,
  applied: readonly string[],
  notes: readonly string[],
  failure?: string,
): string {
  const unremarkable = applied.length === 0 && notes.length === 0 && failure === undefined

  return [
    `dogear: ${root}`,
    ...(unremarkable ? ['nothing changed'] : applied),
    ...(failure === undefined ? [] : [failure]),
    ...notes.map((note) => `note: ${note}`),
  ]
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
