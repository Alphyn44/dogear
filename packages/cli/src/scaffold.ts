import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { QUEUE_DIR } from '@dogear/queue'

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
 * issues. Today there is one step and it makes a directory. E2 (#27) adds detection, E3 (#28)
 * agent wiring, E4 (#29) config and gitignore — each an entry appended to {@link STEPS}, not a
 * change to the runner. Three properties make that work, and none of them survives casual
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

/** One thing `dogear init` is responsible for. E2–E4 each add entries to {@link STEPS}. */
export interface Step {
  /** Internal, for diagnostics. The user reads {@link Change.summary} instead. */
  readonly name: string
  /**
   * Inspect the repository. **Never writes.** Returns `undefined` when the repo already
   * satisfies this step, which is what makes re-running report nothing.
   */
  readonly plan: (root: string) => Change | undefined
}

/**
 * `.dogear/` exists **and is a directory**.
 *
 * E1's only step, and the smallest one that is genuinely load-bearing: every later step and
 * every queue write puts a file inside this directory. `QUEUE_DIR` comes from `@dogear/queue`
 * rather than a second `'.dogear'` literal here — that constant is what `queuePathFor` builds
 * on, so init and the writers cannot disagree about where the directory is.
 *
 * **`existsSync` alone is the bug here, not the shortcut.** It answers true for a *regular
 * file* named `.dogear`, so a step that planned on existence alone would return `undefined`
 * and init would report `nothing changed` over a repository where nothing can ever be written.
 * That is the exact failure the "already correct?" predicate exists to prevent, and it is
 * silent — no throw, exit 0, a confident report. Every step E2–E4 adds has the same trap
 * available to it: **check for the state you need, not for the path being occupied.**
 *
 * `apply` re-checks rather than trusting the plan, which is what turns an opaque `EEXIST` into
 * a sentence naming the fix. `mkdirSync` stays non-recursive: the root is a git root, so it
 * exists, and there is no intermediate directory to create.
 */
const queueDirectory: Step = {
  name: 'queue-directory',
  plan: (root) => {
    const dir = join(root, QUEUE_DIR)
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true) return undefined

    return {
      summary: `created ${QUEUE_DIR}/`,
      apply: () => {
        if (existsSync(dir)) {
          throw new Error(
            `${QUEUE_DIR} exists at ${root} but is not a directory. ` +
              'Remove it and re-run — dogear keeps its queue and config inside it.',
          )
        }

        mkdirSync(dir)
      },
    }
  },
}

/** Run in order. E2–E4 append; detection first, then config, then agent wiring. */
const STEPS: readonly Step[] = [queueDirectory]

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
  const changes = STEPS.map((step) => step.plan(root)).filter(
    (change): change is Change => change !== undefined,
  )

  const applied: string[] = []

  for (const change of changes) {
    try {
      change.apply()
    } catch (error) {
      // Stop here. `applied` holds only what actually happened, so the report stays true and
      // a re-run resumes from this step rather than repeating the ones above it.
      return {
        output: report(root, applied, `failed: ${messageOf(error)}`),
        exitCode: 1,
      }
    }

    applied.push(change.summary)
  }

  return { output: report(root, applied), exitCode: 0 }
}

/**
 * The report. Changes only — an unchanged repo prints `nothing changed` and nothing else.
 *
 * Listing every step with an `ok`/`created` marker was the alternative and is a different
 * command: #26 asks for a re-run that "reports only what changed", and by E4 a per-step
 * checklist would print six lines every time to say that six things were already true.
 */
function report(root: string, applied: readonly string[], failure?: string): string {
  const lines =
    applied.length === 0 && failure === undefined ? ['nothing changed'] : applied

  return [`dogear: ${root}`, ...lines, ...(failure === undefined ? [] : [failure])]
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
