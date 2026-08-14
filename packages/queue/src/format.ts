import type { StoredAnnotation } from '@dogear/queue'

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
 * Both of the brief's original departures are now closed. The `⚠ stale` marker arrived with
 * D5, which computes staleness in ./stale.ts and passes the result in — **this file still
 * touches no filesystem**, and that is load-bearing rather than incidental: D4's clipboard
 * export runs this same formatter in a browser, where there is neither `node:fs` nor a
 * repository to read. It passes no set, and no markers render.
 *
 * The other departure — a missing `dogear_resolve` footer — was A3's, and D1 closed it by
 * registering the tool. The footer is now emitted by default and selected by {@link
 * FormatOptions}, because the one thing that varies between the three callers is what the
 * reader is supposed to do next.
 *
 * Everything else follows the brief. Every field below `sites` is optional in practice: at
 * M0 an annotation carries a comment and whatever the browser knew, and the C epic is what
 * fills in `sites`. A formatter that assumed the finished shape would render "undefined" at
 * every line for the entire first two milestones.
 */

/** `element.text` is capped at 80 chars by the browser; a hand-written file is not. */
const MAX_TEXT = 80

/**
 * The brief's sentence, verbatim. Emitted for the hook and the MCP server, both of which
 * reach an agent that has `dogear_resolve` available — E3 registers the MCP server for every
 * agent and never skips it, so this is not a promise the reader might be unable to keep.
 */
const RESOLVE_FOOTER = 'When you have addressed an item, call dogear_resolve with its id.'

/**
 * D5's explanation of the marker, emitted only when something actually carries it.
 *
 * "in any file it names" rather than the brief's original "the named file": staleness is
 * decided across every site, so an item reaching this state has had its text looked for in
 * several places and found in none. Saying "the named file" would misdescribe both what was
 * checked and how much the reader should distrust the line number.
 */
const STALE_NOTE = [
  'Items marked ⚠ stale no longer have their text snippet in any file they name — the',
  'line number is probably wrong; locate by selector or text instead.',
]

export interface FormatOptions {
  /**
   * What the reader should do next.
   *
   * `'resolve'` (the default) closes the block with the `dogear_resolve` instruction.
   * `'none'` omits it. **D4 adds a third member here** — its clipboard export ends with
   * "…paste this to your agent" instead, since someone pasting into a web chat window has no
   * MCP server to call and telling them to call a tool wastes a turn.
   *
   * A parameter rather than three copies of the renderer: the item block is identical for
   * all three callers, and the closing instruction is the only thing that varies.
   */
  readonly footer?: 'resolve' | 'none'
  /**
   * Ids the caller has determined are stale — D5 (#24).
   *
   * A set computed by ./stale.ts rather than a `gitRoot` this function would read from, so
   * the formatter stays pure and D4 can run it in a browser. Absent means *nothing is
   * marked*, which is exactly right for a caller that has no filesystem: it is the honest
   * answer, not a degraded one, because staleness is a fact about a working tree the browser
   * cannot see.
   */
  readonly stale?: ReadonlySet<string>
}

/**
 * Render pending annotations as the `<dogear-queue>` block.
 *
 * Returns the empty string for an empty list rather than an empty block, **whatever the
 * footer**. The hook puts this on stdout and `UserPromptSubmit` injects stdout verbatim as
 * context, so an empty queue has to produce zero bytes — not a well-formed announcement that
 * there is nothing to announce, and not a lone closing instruction with nothing above it.
 * `dogear_pending` substitutes its own sentence for this case, because an MCP tool returning
 * an empty text block tells the agent nothing.
 */
export function formatQueue(
  items: readonly StoredAnnotation[],
  { footer = 'resolve', stale }: FormatOptions = {},
): string {
  if (items.length === 0) return ''

  const blocks = items.map((item, index) =>
    formatItem(item, index + 1, stale?.has(item.id) === true),
  )

  // Keyed off what was actually *rendered*, not off the set's size. `dogear_pending`'s `app`
  // filter can leave every stale item out of this block, and a note explaining a marker that
  // appears nowhere above it is worse than no note.
  const anyStale = items.some((item) => stale?.has(item.id) === true)

  return [
    `<dogear-queue count="${items.length}">`,
    blocks.join('\n\n'),
    '</dogear-queue>',
    '',
    'These are annotations left by clicking elements in the running app. Each names where',
    'the element was seen; treat the location as a strong hint, not a constraint — if it',
    'does not match, locate the element by its selector or text instead.',
    ...(anyStale ? ['', ...STALE_NOTE] : []),
    ...(footer === 'none' ? [] : ['', RESOLVE_FOOTER]),
  ].join('\n')
}

function formatItem(item: StoredAnnotation, position: number, stale: boolean): string {
  const sites = asArray(item.sites).map(asRecord).filter(isPresent)
  const element = asRecord(item.element)

  // The full id, not the brief example's shortened form. D2's `dogear_resolve` takes ids
  // verbatim, and an abbreviated one would either not match or match ambiguously — the id
  // is the model's handle on the item, so it has to be the real thing.
  // The marker closes the headline, after the location, as the brief's example block has it.
  // Two spaces before it, matching the gap `formatSite` puts before its parenthetical — it is
  // a separate fact about the item, not part of the location.
  const [primary, ...rest] = sites
  const lines = [
    `[${position}] ${item.id}${primary ? ` — ${formatSite(primary)}` : ''}` +
      (stale ? '  ⚠ stale' : ''),
  ]

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
