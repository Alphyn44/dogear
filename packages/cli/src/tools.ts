import type { StoredAnnotation } from '@dogear/queue'
import {
  pendingOnly,
  pruneQueue,
  queuePathFor,
  resolveInQueue,
  tryReadQueue,
  withApp,
} from '@dogear/queue'

import { formatQueue } from './format.js'
import { findStale } from './stale.js'

/**
 * The three MCP tools, as pure functions.
 *
 * Nothing here imports the MCP SDK. ./server.ts owns every line that knows what a JSON-RPC
 * frame is; this file owns every line that knows what dogear does. The split is the same one
 * ./emit.ts made for the hook, for the same reason: it turns the entire feature set into
 * values the fast suite can assert on, leaving only transport plumbing to a suite that has
 * to spawn a process.
 *
 * **This is the whole product.** The brief's rule is that a capability which cannot be
 * reached through MCP does not ship, so anything dogear can do to the queue is one of the
 * three functions below.
 *
 * **Which reader each one uses is not a style choice.** `pending` reads tolerantly, because
 * a hand-broken entry should cost that entry rather than hide the other nine from the agent.
 * `resolve` and `prune` go through `@dogear/queue`'s writers, which read *strictly* — a
 * tolerant read drops malformed entries, so writing one back would silently delete them.
 *
 * **Errors are returned, never thrown.** {@link callTool} is the single boundary: a throw
 * from anywhere below becomes `isError: true` with the message as text. An exception
 * escaping into the transport would take down the stdio session, so one bad call would
 * break every later call rather than just itself.
 */

export type ToolName = 'dogear_pending' | 'dogear_resolve' | 'dogear_prune'

/** A JSON Schema object, kept loose — the SDK re-validates and we do not model its dialect. */
export type JsonSchema = Record<string, unknown>

export interface ToolDescriptor {
  readonly name: ToolName
  readonly title: string
  /**
   * Written for a model, not a changelog.
   *
   * MCP is **pull**: nothing calls these tools unless the agent decides to, so the
   * description is most of what makes dogear work at all. Each one says what the tool does
   * *and when to reach for it*, because "when" is the part an agent has no other way to know.
   *
   * **Two descriptions here carry instructions, not just explanations, and that is D2's
   * doing.** `dogear_pending` names `dogear_resolve` as the next step, and `dogear_resolve`
   * forbids hand-editing the queue. Both sentences also exist elsewhere — the first is
   * `format.ts`'s footer, the second is the brief — and the duplication is deliberate.
   *
   * A description arrives through `tools/list` and stays in the agent's context; a *result*
   * can be dropped. Inspecting a live session during D1 showed Claude Code rendering
   * `structuredContent` and discarding the text block entirely, which took the footer with
   * it — so on the MCP-only baseline the agent was never told to resolve anything. The hook
   * path delivers the footer, the MCP path delivers the description, and neither depends on
   * the other. ./tools.test.ts pins both sentences; do not "de-duplicate" them.
   */
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
}

export interface ToolOutcome {
  /** What the model reads. Never empty — an empty text block tells an agent nothing. */
  readonly text: string
  readonly structured: Record<string, unknown>
  readonly isError: boolean
}

const ANNOTATION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    comment: { type: 'string' },
    // D5. Documented but not required, and present only when true — it is derived at read
    // time from the working tree, so it is a property of this *answer* rather than of the
    // annotation, and it never appears in queue.json.
    stale: { type: 'boolean' },
  },
  required: ['id', 'status', 'comment'],
  // Open on purpose. `sites`, `element`, `app`, `origin` and `note` are all written by the
  // C and B epics and none of them are guaranteed — an annotation from before C3 has no
  // `selector`, and one from a hand-written curl batch may have nothing but a comment.
  additionalProperties: true,
}

export const TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'dogear_pending',
    title: 'Read pending dogear annotations',
    description:
      'Read the pending dogear annotations for this repository — comments a developer left ' +
      'by clicking elements in the running app, each already bound to a source location. ' +
      'Call this at the start of a task, and whenever the user mentions dogear or says they ' +
      'left notes in the UI. After you have addressed an item, call dogear_resolve with ' +
      'its id.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description:
            'Workspace package name to filter to, e.g. "@acme/admin". Matched exactly ' +
            "against the annotation's `app` field. Omit for every pending annotation in " +
            'the repo.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        items: { type: 'array', items: ANNOTATION_SCHEMA },
      },
      required: ['count', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'dogear_resolve',
    title: 'Mark dogear annotations done',
    description:
      'Mark dogear annotations as done, by id. Call this after you have actually addressed ' +
      'a comment. Never edit .dogear/queue.json by hand — this is the only supported way to ' +
      'resolve. Ids that are not in the queue, or are already resolved, are skipped ' +
      'silently; that is not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Full annotation ids, exactly as shown in the queue block. Batch them — one ' +
            'call can resolve several.',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        resolved: { type: 'integer' },
        remaining: { type: 'integer' },
      },
      required: ['resolved', 'remaining'],
      additionalProperties: false,
    },
  },
  {
    name: 'dogear_prune',
    title: 'Drop resolved dogear annotations',
    description:
      'Remove resolved dogear annotations from the queue file, and report how many went. ' +
      'Always explicit — dogear never prunes on a timer or in the background. Pending ' +
      'annotations are never touched.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { pruned: { type: 'integer' } },
      required: ['pruned'],
      additionalProperties: false,
    },
  },
]

/**
 * Dispatch one tool call, converting every failure into a reportable outcome.
 *
 * The single `try` in this file, and deliberately so. `resolveInQueue` and `pruneQueue`
 * throw on a corrupt queue — that is the behaviour that stops them overwriting bytes they
 * could not parse — and this is where that throw stops being an exception and becomes an
 * answer the agent can act on.
 */
export function callTool(gitRoot: string, name: string, args: unknown): ToolOutcome {
  try {
    switch (name) {
      case 'dogear_pending':
        return pending(gitRoot, args)
      case 'dogear_resolve':
        return resolve(gitRoot, args)
      case 'dogear_prune':
        return prune(gitRoot)
      default:
        return failure(
          `unknown tool ${JSON.stringify(name)}. dogear exposes ${TOOLS.map(
            (tool) => tool.name,
          ).join(', ')}.`,
        )
    }
  } catch (error) {
    return failure(messageOf(error))
  }
}

/**
 * `dogear_pending` — the read path. Tolerant, because a read cannot damage anything.
 *
 * Like its two siblings, this **may throw** on filesystem failure and does not catch for
 * itself; {@link callTool} is the one adapter that converts a throw into a reportable
 * outcome. D6's `dogear prune` and `POST /__dogear/prune` will want their own presentation
 * of the same failure, which is why the conversion lives in the MCP adapter rather than
 * here. (Argument problems are different — those are *returned*, since they are answers
 * rather than accidents.)
 */
export function pending(gitRoot: string, args: unknown): ToolOutcome {
  const app = readApp(args)
  if (app.ok === false) return failure(app.error)

  const queuePath = queuePathFor(gitRoot)
  const queue = tryReadQueue(queuePath)

  // Reported rather than swallowed. A hook must degrade to silence because it cannot exit
  // non-zero, but a tool call has a real error channel — and an agent told "nothing pending"
  // for a file it could not parse would conclude there is no work and move on.
  if (!queue.ok) return failure(queue.reason)

  const allPending = pendingOnly(queue.items)
  const items = app.value === undefined ? allPending : withApp(allPending, app.value)

  // Computed after the filter, so a repo-wide read does not pay to stat files belonging to
  // items the caller asked to exclude.
  const stale = findStale(items, gitRoot)

  return {
    text: describePending(items, allPending.length, app.value, stale),
    // **`stale` goes in the structured output too, and that is not redundancy.** D1 found
    // Claude Code rendering `structuredContent` and discarding the text block entirely — the
    // same discovery that made D2 put the resolve instruction in the tool description. A
    // marker that existed only in the formatted block would never reach a model on the
    // MCP-only baseline, which would make D5 a capability that works solely behind the hook.
    //
    // Set only when true, so a fresh item's structured shape is byte-identical to what is on
    // disk. It is derived per call and never written back; see ./stale.ts.
    structured: {
      count: items.length,
      items: items.map((item) => (stale.has(item.id) ? { ...item, stale: true } : item)),
    },
    isError: false,
  }
}

/** `dogear_resolve` — D2's "a tool call cannot corrupt the queue". */
export function resolve(gitRoot: string, args: unknown): ToolOutcome {
  const ids = readIds(args)
  if (ids.ok === false) return failure(ids.error)

  const { resolved, remaining } = resolveInQueue(queuePathFor(gitRoot), ids.value)
  const skipped = ids.value.length - resolved

  const lines = [`Resolved ${count(resolved, 'annotation')}.`]

  // Said explicitly rather than left for the agent to infer from the numbers. Silence here
  // reads as success, and an agent that resolved a stale id should learn that it did.
  if (skipped > 0) {
    lines.push(
      `${count(skipped, 'requested id')} did not match a pending annotation — already ` +
        'resolved, or no longer in the queue. That is not an error.',
    )
  }

  lines.push(`${count(remaining, 'annotation')} still pending.`)

  return { text: lines.join(' '), structured: { resolved, remaining }, isError: false }
}

/** `dogear_prune` — D6 reuses the same operation for the CLI and the endpoint. */
export function prune(gitRoot: string): ToolOutcome {
  const { pruned, remaining } = pruneQueue(queuePathFor(gitRoot))

  const text =
    pruned === 0
      ? 'Nothing to prune — no resolved annotations in the queue.'
      : `Pruned ${count(pruned, 'resolved annotation')}. ` +
        `${count(remaining, 'annotation')} still pending.`

  return { text, structured: { pruned }, isError: false }
}

function describePending(
  items: readonly StoredAnnotation[],
  totalPending: number,
  app: string | undefined,
  stale: ReadonlySet<string>,
): string {
  if (items.length > 0) return formatQueue(items, { stale })

  if (app === undefined) return 'No pending dogear annotations in this repo.'

  // The filter, not the repo, is why this came back empty — and saying so is the difference
  // between the agent asking again without the filter and concluding there is no work.
  if (totalPending > 0) {
    return (
      `No pending dogear annotations for app ${JSON.stringify(app)}. ` +
      `${count(totalPending, 'annotation')} pending in this repo overall — call again ` +
      'without the filter to see them.'
    )
  }

  return `No pending dogear annotations in this repo, for ${JSON.stringify(app)} or any other app.`
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/**
 * Argument validation, hand-written in `validateBatch`'s style: shallow, returning rather
 * than throwing, and naming what was actually received.
 *
 * Hand-written rather than declared with zod, which `McpServer.registerTool` would want.
 * The schemas above already travel to the client, so zod would buy a second direct
 * dependency and a second description of the same shape — and it would move validation
 * behind the SDK, out of reach of the fast suite.
 */
function readApp(args: unknown): Parsed<string | undefined> {
  const record = asRecord(args)
  if (record === undefined) return { ok: false, error: 'arguments must be an object' }

  const app = record['app']
  if (app === undefined) return { ok: true, value: undefined }
  if (typeof app !== 'string' || app === '') {
    return {
      ok: false,
      error: `app must be a non-empty string when present, received ${JSON.stringify(app)}`,
    }
  }

  return { ok: true, value: app }
}

function readIds(args: unknown): Parsed<readonly string[]> {
  const record = asRecord(args)
  if (record === undefined) return { ok: false, error: 'arguments must be an object' }

  const ids = record['ids']
  if (!Array.isArray(ids)) {
    return { ok: false, error: `ids must be an array, received ${JSON.stringify(ids)}` }
  }
  if (ids.length === 0) return { ok: false, error: 'ids must not be empty' }

  const bad = ids.filter((id) => typeof id !== 'string' || id === '')
  if (bad.length > 0) {
    return {
      ok: false,
      error: `every id must be a non-empty string; received ${JSON.stringify(bad)}`,
    }
  }

  return { ok: true, value: ids as readonly string[] }
}

function failure(reason: string): ToolOutcome {
  return { text: `dogear: ${reason}`, structured: {}, isError: true }
}

/** `1 annotation` / `3 annotations` — the counts appear in prose the model reads. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  // Absent arguments are an empty object, not a failure: `dogear_prune` takes none, and
  // `dogear_pending`'s only field is optional.
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
