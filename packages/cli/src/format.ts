import type { Annotation } from './queue.js'

/**
 * The agent-facing rendering of the queue, specified in the brief under "Agent-facing
 * format".
 *
 * This is written as **the** formatter, not as a throwaway for A3. The brief's ordering
 * argument — MCP before the hook, "building the hook first would mean writing the formatter
 * twice" — holds only because `dogear mcp` (D1) and `dogear hook` live in the same package
 * and can share this file. D1 and D4's clipboard export call it; the hook is a trigger, not
 * a second implementation.
 *
 * Two deliberate departures from the brief's example block, both because A3 predates the
 * machinery the example assumes:
 *
 * 1. **No `dogear_resolve` footer.** The tool does not exist until D1 registers it. Telling
 *    the model to call a tool that is not there costs it a turn discovering that.
 * 2. **No `⚠ stale` marker.** Staleness is derived by re-reading the source file for the
 *    text snippet, which is D5's work. Nothing computes it yet, so nothing renders it.
 *
 * Everything else follows the brief. Every field below `sites` is optional in practice: at
 * M0 an annotation carries a comment and whatever the browser knew, and the C epic is what
 * fills in `sites`. A formatter that assumed the finished shape would render "undefined" at
 * every line for the entire first two milestones.
 */

/** `element.text` is capped at 80 chars by the browser; a hand-written file is not. */
const MAX_TEXT = 80

/**
 * Render pending annotations as the `<dogear-queue>` block.
 *
 * Returns the empty string for an empty list rather than an empty block. The caller puts
 * this on stdout, and `UserPromptSubmit` injects stdout verbatim as context — so an empty
 * queue has to produce zero bytes, not a well-formed announcement that there is nothing to
 * announce.
 */
export function formatQueue(items: readonly Annotation[]): string {
  if (items.length === 0) return ''

  const blocks = items.map((item, index) => formatItem(item, index + 1))

  return [
    `<dogear-queue count="${items.length}">`,
    blocks.join('\n\n'),
    '</dogear-queue>',
    '',
    'These are annotations left by clicking elements in the running app. Each names where',
    'the element was seen; treat the location as a strong hint, not a constraint — if it',
    'does not match, locate the element by its selector or text instead.',
    // TODO(dogear): D1 appends the `dogear_resolve` instruction here once the MCP server
    // registers the tool. D4's clipboard variant appends "…paste this to your agent"
    // instead, since a pasting user has no MCP server.
  ].join('\n')
}

function formatItem(item: Annotation, position: number): string {
  const sites = asArray(item.sites).map(asRecord).filter(isPresent)
  const element = asRecord(item.element)

  // The full id, not the brief example's shortened form. D2's `dogear_resolve` takes ids
  // verbatim, and an abbreviated one would either not match or match ambiguously — the id
  // is the model's handle on the item, so it has to be the real thing.
  const [primary, ...rest] = sites
  const lines = [`[${position}] ${item.id}${primary ? ` — ${formatSite(primary)}` : ''}`]

  for (const site of rest) lines.push(`    also: ${formatSite(site)}`)

  const app = asString(item.app)
  const where = asString(item.url) ?? asString(item.origin)
  if (app !== undefined || where !== undefined) {
    lines.push(`    app: ${[app, where].filter(isPresent).join(' — ')}`)
  }

  const selector = element && asString(element.selector)
  if (selector !== undefined) lines.push(`    selector: ${selector}`)

  const text = element && asString(element.text)
  if (text !== undefined) lines.push(`    text: ${JSON.stringify(truncate(text))}`)

  // B5's (#12) batch note, above the comment because it is context rather than payload —
  // the instruction that applied to the whole batch this item arrived in.
  //
  // Rendered per item, and deliberately not deduped across consecutive items that share
  // one. "Consecutive" stops being a batch boundary the moment resolve and prune interleave
  // the file, so grouping on it would eventually attribute one batch's note to another's
  // items — a wrong instruction is worse than a repeated one.
  const note = asString(item.note)
  if (note !== undefined) lines.push(`    note: ${note}`)

  // Last, and unconditional. The comment is the only field an annotation cannot exist
  // without — everything above it is context for finding what the comment is about.
  lines.push(`    comment: ${item.comment}`)

  return lines.join('\n')
}

/** `src/components/Button.tsx:12  (Button, via attribute)` — trailing parts omitted if absent. */
function formatSite(site: Record<string, unknown>): string {
  const file = asString(site.file)
  if (file === undefined) return '(unknown location)'

  const line = asNumber(site.line)
  const located = line === undefined ? file : `${file}:${line}`

  const component = asString(site.component)
  const via = asString(site.via)
  const detail = [component, via && `via ${via}`].filter(isPresent).join(', ')

  return detail === '' ? located : `${located}  (${detail})`
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}…`
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function isPresent<T>(value: T | undefined | ''): value is T {
  return value !== undefined && value !== ''
}
