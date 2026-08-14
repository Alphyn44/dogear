import type { StoredAnnotation } from './queue.js'

/**
 * The agent-facing rendering of the queue, specified in the brief under "Agent-facing
 * format".
 *
 * This is written as **the** formatter, not as a throwaway for A3. There are three callers —
 * `dogear mcp` (D1), `dogear hook` (D3), and D4's (#23) clipboard export — and the hook is a
 * trigger rather than a second implementation.
 *
 * **It lives in @dogear/queue, and the third caller is why.** The first two are `@dogear/cli`
 * and could have shared a file there; `@dogear/core` is the browser half, declares no
 * dependencies of its own, and cannot import a bin package. Moving the formatter down to the
 * package that already owns {@link StoredAnnotation} gives all three one copy instead of two
 * and a drift test.
 *
 * **This file must never import a `node:` module.** It is reachable at the `./format` export
 * subpath — deliberately separate from `.`, whose `./index.js` pulls in `node:fs` — and
 * @dogear/core inlines it into `client.js`, which runs in a browser. A single `node:` import
 * here is an overlay that fails to load, and nothing in the Node-side suites would see it.
 * ./format.test.ts guards the rule mechanically.
 *
 * Both of the brief's original departures are now closed. The `⚠ stale` marker arrived with
 * D5, which computes staleness in ../../cli/src/stale.ts and passes the result in — so this
 * file touches no filesystem, which is the same constraint stated from the other end. The
 * browser passes no set, and no markers render.
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

/**
 * Re-exported so the `./format` subpath is self-sufficient.
 *
 * @dogear/core needs this type to build what it passes in, and reaching for it through the
 * package's `.` entry would name the module graph that imports `node:fs` from a file bundled
 * for a browser. Type-only, so it erases entirely — but a value import written there by
 * mistake would not, and the point of the separate subpath is that the mistake is unavailable.
 */
export type { StoredAnnotation } from './queue.js'

/** `element.text` is capped at 80 chars by the browser; a hand-written file is not. */
const MAX_TEXT = 80

/**
 * The brief's sentence, verbatim. Emitted for the hook and the MCP server, both of which
 * reach an agent that has `dogear_resolve` available — E3 registers the MCP server for every
 * agent and never skips it, so this is not a promise the reader might be unable to keep.
 */
const RESOLVE_FOOTER = 'When you have addressed an item, call dogear_resolve with its id.'

/**
 * D4's (#23) closing line, and it is not the brief's original wording — see the Decisions log.
 *
 * The brief said "…paste this to your agent", which addresses the person doing the pasting.
 * By the time anything reads this line the pasting has happened, and the reader is the agent.
 * It also cannot claim there is no MCP server: the browser has no idea where a paste lands,
 * and it may well be a session with `dogear_resolve` registered.
 *
 * What *is* true in every destination is the fact this states. The clipboard export renders
 * the browser's in-memory batch, which never reached `queue.json` and carries no ids — so
 * `dogear_resolve` cannot act on these items whatever tooling the reader has, and an agent
 * that has seen the tool elsewhere should not go inventing ids to call it with.
 *
 * Split across two lines because the sentence is longer than Prettier's print width, not for
 * any rendering reason — it is emitted as one line.
 */
const PASTE_FOOTER =
  'These were pasted in rather than read from the queue, so there is nothing to ' +
  'resolve when you are done.'

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
   * `'resolve'` (the default) closes the block with the `dogear_resolve` instruction, for the
   * two callers whose items are on disk and addressable by id. `'paste'` is D4's (#23)
   * clipboard export — see {@link PASTE_FOOTER}. `'none'` omits the line entirely.
   *
   * A parameter rather than three copies of the renderer: the item block is identical for
   * all three callers, and the closing instruction is the only thing that varies.
   */
  readonly footer?: 'resolve' | 'none' | 'paste'
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
    // Stale note first, footer last, whichever footer it is — the brief pins that order under
    // "Agent-facing format", and it is the useful one: what is wrong with the block, then what
    // to do about it.
    ...(footer === 'none'
      ? []
      : ['', footer === 'paste' ? PASTE_FOOTER : RESOLVE_FOOTER]),
  ].join('\n')
}

function formatItem(item: StoredAnnotation, position: number, stale: boolean): string {
  const sites = asArray(item.sites).map(asRecord).filter(isPresent)
  const element = asRecord(item.element)

  // The full id, not the brief example's shortened form. D2's `dogear_resolve` takes ids
  // verbatim, and an abbreviated one would either not match or match ambiguously — the id
  // is the model's handle on the item, so it has to be the real thing.
  //
  // **Omitted when there isn't one**, which is D4's (#23) case and only D4's: the clipboard
  // export renders the browser's in-memory batch, and identity is stamped by the server at
  // submit, so those items genuinely have no id to print. `[1] — src/Button.tsx:20` is the
  // honest rendering; the positional number is the reader's handle, and a resolve instruction
  // is not emitted for that footer anyway. `asString` already maps `''` to undefined, so this
  // is one call rather than a new predicate, and an item that *has* an id renders unchanged.
  //
  // The marker closes the headline, after the location, as the brief's example block has it.
  // Two spaces before it, matching the gap `formatSite` puts before its parenthetical — it is
  // a separate fact about the item, not part of the location.
  const id = asString(item.id)
  const [primary, ...rest] = sites
  const lines = [
    `[${position}]${id === undefined ? '' : ` ${id}`}` +
      (primary ? ` — ${formatSite(primary)}` : '') +
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
