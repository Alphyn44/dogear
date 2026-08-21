/**
 * Adding one member to a JSON file **without rewriting the rest of it** — E3 (#28).
 *
 * `dogear init` has to put an entry into `.mcp.json` and into `.claude/settings.json`, and both
 * are files the user owns and has usually hand-formatted. The obvious implementation is
 * `JSON.parse` → mutate → `JSON.stringify(…, null, 2)`, and it is wrong here for a concrete
 * reason rather than a stylistic one: this repository's own `.claude/settings.json` writes
 * entries like `{ "type": "command", "command": "bash \"…\"" }` on a single line, and
 * re-serialising explodes every one of them onto four. The user asked for a hook and got a
 * whole-file diff.
 *
 * **JSON cannot be appended to at the file level.** A JSON document is one value, so text after
 * the closing brace is a second value and no parser accepts it. What *is* available — and what
 * this module does — is inserting before the **enclosing** closing bracket: appending to the
 * container's contents rather than to the file. Every byte outside the insertion is untouched.
 *
 * **Three rules make it safe rather than merely careful:**
 *
 * 1. **The scanner tracks string literals.** A `}` inside `"command": "bash \"…\""` is not a
 *    closing brace, and a matcher that counted brackets naively would splice into the middle of
 *    someone's shell command.
 * 2. **The result is parsed before it is returned.** {@link insertAt} hands back `undefined`
 *    rather than text it could not verify, so a caller can never write a broken config — the
 *    failure mode this replaces is one where the user's agent stops starting up.
 * 3. **`undefined` is an ordinary answer.** An absent path, a shape the scanner does not
 *    recognise, a JSONC file with comments in it — all of them decline rather than throw, which
 *    is what lets a `Step` plan around them. See ./mcp-config.ts, where declining becomes a
 *    printed snippet the user can paste.
 *
 * Deliberately not a JSON5/JSONC editor and deliberately not a dependency: `dogear-cli` has
 * exactly one dependency and it is the MCP SDK. The whole surface is two functions.
 *
 * ---
 *
 * **E6 (#39) added {@link removeAt}, and it is the mirror rather than a second implementation.**
 * Undoing an init has to take dogear's entry back out of the same two files, under the same
 * constraint and with more at stake: an insert that reformats is rude, and a *remove* that
 * reformats is rude about bytes the user is keeping. Both functions share the scanner below —
 * {@link memberAt}, {@link matching}, {@link stringAt} — so the two directions cannot develop
 * different ideas about where a member begins.
 *
 * The one asymmetry worth naming: `insertAt`'s `path` names the **container** to insert into,
 * and `removeAt`'s names the **member** to take out. There is no other way to say which member,
 * and it means the two are not off-by-one versions of each other by accident.
 */

/**
 * A chain of object keys and array indices naming a value in the document.
 *
 * Numbers were added by E6, which has to reach an element of `hooks.UserPromptSubmit`. They are
 * accepted anywhere in the chain rather than only at the end, because a scanner that special-
 * cased the last segment would be a second set of rules to keep in step with the first.
 */
export type JsonPath = readonly (string | number)[]

/**
 * Insert `snippet` as a new member of the container at `path`, preserving every other byte.
 *
 * `path` names the container to insert into; `[]` is the document's root object. The container
 * may be an object or an array, and `snippet` has to match: a `"key": value` pair for an
 * object, a bare value for an array. Indentation is taken from the members already there, so
 * the result reads as though it had always been in the file.
 *
 * Returns `undefined` when the path is absent, when the value at it is neither an object nor an
 * array, or when the spliced text would not parse.
 *
 * ```ts
 * insertAt(source, [], '"hooks": {}')                      // a new top-level key
 * insertAt(source, ['hooks'], '"UserPromptSubmit": []')     // into an existing object
 * insertAt(source, ['hooks', 'UserPromptSubmit'], '{ … }')  // onto an existing array
 * ```
 */
export function insertAt(
  source: string,
  path: JsonPath,
  snippet: string,
): string | undefined {
  const span = locate(source, path)
  if (span === undefined) return undefined

  const spliced = splice(source, span, snippet)

  // Rule 2. Everything above is text manipulation over a format with real syntax, and the only
  // honest way to claim the output is still JSON is to ask a parser. A caller that gets text
  // back has a guarantee; one that gets `undefined` has a fallback.
  return parseable(spliced) ? spliced : undefined
}

/**
 * Remove the member at `path`, preserving every other byte — E6 (#39).
 *
 * `path` names the **member**, not its container: the last segment is the key or index to take
 * out. `[]` is not a member and is declined; a document cannot remove itself.
 *
 * Returns `undefined` on the same terms as {@link insertAt} — an absent path, a segment whose
 * kind does not match the container it names, or a result that would not parse.
 *
 * ```ts
 * removeAt(source, ['mcpServers', 'dogear'])            // a key
 * removeAt(source, ['hooks', 'UserPromptSubmit', 1])    // an array element
 * ```
 */
export function removeAt(source: string, path: JsonPath): string | undefined {
  const key = path.at(-1)
  if (key === undefined) return undefined

  const container = narrow(source, path.slice(0, -1))
  if (container === undefined) return undefined

  const span = interiorOf(source, container[0], container[1])
  if (span === undefined) return undefined

  const member = memberAt(source, container[0], container[1], key)
  if (member === undefined) return undefined

  const spliced = excise(source, span, member)

  // Rule 2 again, and it is doing more work here than above: removing the wrong span produces
  // text that is *usually* still valid JSON, so the parse check is a floor rather than a proof.
  // What actually keeps the span right is that {@link memberAt} finds it with the same scanner
  // `insertAt` places members with.
  return parseable(spliced) ? spliced : undefined
}

/**
 * Remove the member at `path` **if what is there is now empty**, otherwise change nothing.
 *
 * The cascade after a {@link removeAt} — E6 (#39). Taking dogear's hook out of
 * `hooks.UserPromptSubmit` leaves `"UserPromptSubmit": []`, and taking its server out of
 * `mcpServers` leaves `"mcpServers": {}`. Both are exactly the residue #39 exists to remove:
 * dogear created those containers on the way in, and a settings file still carrying them still
 * says dogear was here.
 *
 * **Safe because an empty hook container does nothing.** This is the one place undo removes
 * something it cannot prove it wrote — a repository whose `settings.json` carried an empty
 * `"UserPromptSubmit": []` *before* init loses it. That costs nothing at all: an empty array of
 * hooks and an absent key are the same configuration, and the alternative is leaving visible
 * litter in the common case to preserve a byte that has no meaning in the rare one.
 *
 * Never throws and never declines: an unparseable document, an absent path, a value that is not
 * empty, or a splice that would not re-parse all return `source` untouched. It is a tidy-up
 * pass, so having no effect is always an acceptable outcome.
 */
export function pruneEmpty(source: string, path: JsonPath): string {
  let value: unknown
  try {
    value = JSON.parse(stripBom(source))
  } catch {
    return source
  }

  for (const segment of path) {
    if (typeof value !== 'object' || value === null) return source
    value = (value as Record<string, unknown>)[String(segment)]
  }

  const empty = Array.isArray(value)
    ? value.length === 0
    : typeof value === 'object' && value !== null && Object.keys(value).length === 0

  return empty ? (removeAt(source, path) ?? source) : source
}

/**
 * Cut `member` out of `span`, taking exactly one separator with it.
 *
 * **The comma goes with the member, and which one depends on where it sits.** A member with
 * something before it takes the comma *behind* it — along with the whitespace and newline
 * between them, which is what keeps the previous member's line from being left with a trailing
 * comma and an empty line under it. A first member takes the comma *ahead* of it, and the
 * whitespace after that comma too, so the member that becomes first inherits the indentation it
 * already had rather than the departing member's.
 *
 * A container's last remaining member takes the container's whole interior with it, so
 * `{\n  "a": 1\n}` becomes `{}` rather than a brace pair around a blank line.
 *
 * Every case is a pair of slices at indices into the original text, which is why CRLF survives
 * without being mentioned: no line ending is ever rebuilt, only skipped over.
 */
function excise(source: string, span: Span, member: Member): string {
  const before = lastNonSpace(source, span.open, member.start)
  if (before >= span.open && source[before] === ',') {
    return `${source.slice(0, before)}${source.slice(member.end)}`
  }

  const after = skipSpace(source, member.end, span.close)
  if (after < span.close && source[after] === ',') {
    const next = skipSpace(source, after + 1, span.close)
    return `${source.slice(0, member.start)}${source.slice(next)}`
  }

  return `${source.slice(0, span.open)}${source.slice(span.close)}`
}

/**
 * Does this parse, ignoring a leading byte order mark?
 *
 * The BOM is stripped for the *check* and kept in the returned text, which is the whole point:
 * a file that opened with one still opens with one afterwards. Callers parse the same way — see
 * ./mcp-config.ts and ./hook-config.ts — so a BOM never reaches `JSON.parse`, which throws on it.
 */
export function parseable(source: string): boolean {
  try {
    JSON.parse(stripBom(source))
    return true
  } catch {
    return false
  }
}

/** A leading `﻿` removed, and nothing else touched. */
export function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
}

/** A container's interior: where its members start and where its closing bracket sits. */
interface Span {
  /** Index just after the opening bracket. */
  readonly open: number
  /** Index of the closing bracket. */
  readonly close: number
  /** Whether anything is in there already. */
  readonly empty: boolean
  /** The leading whitespace of the container's own line, for an empty container's indent. */
  readonly outdent: string
  /** The leading whitespace of the first member, when there is one. */
  readonly indent: string | undefined
}

/**
 * One member of a container: where it starts, where it ends, and where its value sits.
 *
 * {@link start} is the key's opening quote for an object member and the value itself for an
 * array element — the first byte that belongs to *this* member and to nothing else, which is
 * what {@link excise} needs. {@link value} is the narrower span a path walks down into.
 */
interface Member {
  readonly start: number
  /** Index just past the member's value. Never includes a separator. */
  readonly end: number
  readonly value: readonly [number, number]
}

/** The end-of-line sequence the file uses, taken from its first one. */
function newlineOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Put `snippet` inside `span`, indented to match, with a comma where one is needed.
 *
 * The comma goes **after the last existing member**, not before the new one, so the file never
 * passes through a state with a dangling separator and the diff shows one changed line where a
 * previous member gained its comma.
 */
function splice(source: string, span: Span, snippet: string): string {
  const eol = newlineOf(source)
  const { open, close, empty, outdent, indent } = span

  // No usable member indent — an empty container, or one written inline as `{ "a": 1 }` — so it
  // is derived instead: one level in from the line the container itself starts on. Two spaces
  // because that is what dogear writes into a file it creates from scratch anyway.
  const at = indent ?? `${outdent}  `

  // Every line gets the same prefix, which preserves the snippet's own internal indentation
  // rather than flattening it.
  const body = snippet
    .split('\n')
    .map((line) => `${at}${line}`)
    .join(eol)

  const after = source.slice(close)

  if (empty) {
    // `{}` becomes `{\n  <member>\n}`. The closing bracket keeps the container's own indent,
    // which is what `outdent` is for.
    return `${source.slice(0, open)}${eol}${body}${eol}${outdent}${after}`
  }

  // Trailing whitespace between the last member and the bracket is reproduced rather than
  // preserved: it is what separates the last member from the bracket, and the new member goes
  // between them. `end` is the index just past the last non-whitespace character.
  const end = lastNonSpace(source, open, close) + 1
  const gap = source.slice(end, close)

  return `${source.slice(0, end)},${eol}${body}${gap}${after}`
}

/** Index of the last non-whitespace character in `[from, to)`, or `from - 1` if there is none. */
function lastNonSpace(source: string, from: number, to: number): number {
  for (let index = to - 1; index >= from; index -= 1) {
    if (!isSpace(source.charCodeAt(index))) return index
  }
  return from - 1
}

/**
 * Whitespace, for the purposes of the structural scan — plus the byte order mark.
 *
 * `﻿` is not whitespace to a JSON parser (`JSON.parse` throws on a leading one), but it is
 * exactly what several Windows editors put in front of a `.claude/settings.json`, and it is
 * structurally inert: a BOM anywhere it could legitimately appear is either before the opening
 * bracket or inside a string literal, and literals are skipped whole. Treating it as space here
 * is what lets {@link insertAt} find the container at all — see {@link parseable}, which is the
 * other half.
 */
function isSpace(code: number): boolean {
  return (
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0xfeff
  )
}

/** Find the container at `path` and describe its interior. */
function locate(source: string, path: JsonPath): Span | undefined {
  const span = narrow(source, path)
  return span === undefined ? undefined : interiorOf(source, span[0], span[1])
}

/**
 * The span of the value `path` names, `[0, length)` for an empty path.
 *
 * Walks one segment at a time, each time narrowing to the value that segment names. Returns
 * `undefined` the moment a segment is missing or a value is a scalar — a path into a string is
 * not a container, and guessing what the user meant is exactly the guessing this module exists
 * to avoid.
 */
function narrow(source: string, path: JsonPath): readonly [number, number] | undefined {
  let from = 0
  let to = source.length

  for (const segment of path) {
    const member = memberAt(source, from, to, segment)
    if (member === undefined) return undefined
    ;[from, to] = member.value
  }

  return [from, to]
}

/**
 * The interior of the object or array occupying `[from, to)`.
 *
 * `from` may point at leading whitespace — the root call passes the whole document, and a value
 * span starts after its colon — so the opening bracket is searched for rather than assumed.
 */
function interiorOf(source: string, from: number, to: number): Span | undefined {
  const start = skipSpace(source, from, to)
  const bracket = source[start]
  if (bracket !== '{' && bracket !== '[') return undefined

  const close = matching(source, start, to)
  if (close === undefined) return undefined

  const open = start + 1
  const first = skipSpace(source, open, close)
  const empty = first === close

  return {
    open,
    close,
    empty,
    outdent: lineIndentAt(source, start),
    // Only when the first member is on a line of its own. A container written inline —
    // `{ "a": 1 }` — has a first member whose line indent is the *bracket's*, so copying it
    // would insert the new member at the container's own level rather than inside it. Left
    // undefined, {@link splice} derives one instead.
    indent:
      empty || lineOf(source, first) === lineOf(source, start)
        ? undefined
        : lineIndentAt(source, first),
  }
}

/** The leading whitespace of the line `index` falls on. */
function lineIndentAt(source: string, index: number): string {
  const start = lineOf(source, index)
  return /^[ \t]*/.exec(source.slice(start))?.[0] ?? ''
}

/** The index at which `index`'s line begins. */
function lineOf(source: string, index: number): number {
  return source.lastIndexOf('\n', index) + 1
}

/**
 * The member `segment` names, within the container occupying `[from, to)`.
 *
 * Only members at the container's own depth are considered, which is what keeps a nested
 * `"hooks"` belonging to something else from being mistaken for the one asked for.
 *
 * **The segment's type chooses the container it will accept.** A string names an object member
 * and a number an array element, so asking an array for a key — or an object for an index —
 * declines rather than searching. That is not strictness for its own sake: a path is written by
 * a caller that believes it knows the shape, and a mismatch means the file is not the shape it
 * believed, which is the case {@link removeAt} has to report rather than improvise around.
 */
function memberAt(
  source: string,
  from: number,
  to: number,
  segment: string | number,
): Member | undefined {
  const keyed = typeof segment === 'string'
  const start = skipSpace(source, from, to)
  if (source[start] !== (keyed ? '{' : '[')) return undefined

  const close = matching(source, start, to)
  if (close === undefined) return undefined

  let index = start + 1
  let position = 0

  while (index < close) {
    index = skipSpace(source, index, close)
    if (index >= close) return undefined

    const memberStart = index
    let key: string | undefined

    if (keyed) {
      if (source[index] !== '"') return undefined

      const name = stringAt(source, index, close)
      if (name === undefined) return undefined

      const colon = skipSpace(source, name.end, close)
      if (source[colon] !== ':') return undefined

      key = name.value
      index = colon + 1
    }

    const valueStart = skipSpace(source, index, close)
    const valueEnd = endOfValue(source, valueStart, close)
    if (valueEnd === undefined) return undefined

    if (keyed ? key === segment : position === segment) {
      return { start: memberStart, end: valueEnd, value: [valueStart, valueEnd] }
    }

    const next = skipSpace(source, valueEnd, close)
    if (next >= close) return undefined
    if (source[next] !== ',') return undefined

    index = next + 1
    position += 1
  }

  return undefined
}

/** Where the value starting at `start` ends, exclusive. */
function endOfValue(source: string, start: number, to: number): number | undefined {
  const char = source[start]

  if (char === '{' || char === '[') {
    const close = matching(source, start, to)
    return close === undefined ? undefined : close + 1
  }

  if (char === '"') return stringAt(source, start, to)?.end

  // A number, `true`, `false` or `null` — everything up to the next structural character.
  let index = start
  while (
    index < to &&
    !',}]'.includes(source[index] ?? '') &&
    !isSpace(source.charCodeAt(index))
  ) {
    index += 1
  }

  return index === start ? undefined : index
}

/**
 * The string literal starting at `start`, with the index just past its closing quote.
 *
 * The escape handling is the whole point of this function existing separately: `\\"` ends the
 * string and `\"` does not, so a scanner that only looked at the preceding character would get
 * `"a\\"` wrong. Counting the run of backslashes is the version that does not.
 */
function stringAt(
  source: string,
  start: number,
  to: number,
): { readonly value: string; readonly end: number } | undefined {
  let index = start + 1

  while (index < to) {
    const char = source[index]

    if (char === '\\') {
      index += 2
      continue
    }

    if (char === '"') {
      const raw = source.slice(start, index + 1)
      try {
        return { value: JSON.parse(raw) as string, end: index + 1 }
      } catch {
        return undefined
      }
    }

    index += 1
  }

  return undefined
}

/**
 * The index of the bracket closing the one at `start`.
 *
 * Rule 1: string literals are skipped whole, so `"}"` inside a value never decrements the
 * depth. Comments are *not* skipped — a JSONC file therefore ends up either failing here or
 * failing the parse check in {@link insertAt}, which is the graceful path rather than a gap.
 */
function matching(source: string, start: number, to: number): number | undefined {
  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let index = start

  while (index < to) {
    const char = source[index]

    if (char === '"') {
      const literal = stringAt(source, index, to)
      if (literal === undefined) return undefined
      index = literal.end
      continue
    }

    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }

    index += 1
  }

  return undefined
}

function skipSpace(source: string, from: number, to: number): number {
  let index = from
  while (index < to && isSpace(source.charCodeAt(index))) index += 1
  return index
}
