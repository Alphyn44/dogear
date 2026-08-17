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
 * Deliberately not a JSON5/JSONC editor and deliberately not a dependency: `@dogear/cli` has
 * exactly one dependency and it is the MCP SDK. The whole surface is one function.
 */

/**
 * Insert `snippet` as a new member of the container at `path`, preserving every other byte.
 *
 * `path` is a chain of object keys naming the container to insert into; `[]` is the document's
 * root object. The container may be an object or an array, and `snippet` has to match: a
 * `"key": value` pair for an object, a bare value for an array. Indentation is taken from the
 * members already there, so the result reads as though it had always been in the file.
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
  path: readonly string[],
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

/**
 * Find the container at `path` and describe its interior.
 *
 * Walks the path one key at a time, each time narrowing to the value that key names. Returns
 * `undefined` the moment a key is missing or a value is a scalar — a path into a string is not
 * a container, and guessing what the user meant is exactly the guessing this module exists to
 * avoid.
 */
function locate(source: string, path: readonly string[]): Span | undefined {
  let from = 0
  let to = source.length

  for (const key of path) {
    const value = valueOf(source, from, to, key)
    if (value === undefined) return undefined
    ;[from, to] = value
  }

  return interiorOf(source, from, to)
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
 * The span of the value `key` names, within the object occupying `[from, to)`.
 *
 * Only members at the object's own depth are considered, which is what keeps a nested
 * `"hooks"` belonging to something else from being mistaken for the one asked for.
 */
function valueOf(
  source: string,
  from: number,
  to: number,
  key: string,
): readonly [number, number] | undefined {
  const start = skipSpace(source, from, to)
  if (source[start] !== '{') return undefined

  const close = matching(source, start, to)
  if (close === undefined) return undefined

  let index = start + 1

  while (index < close) {
    index = skipSpace(source, index, close)
    if (index >= close) return undefined
    if (source[index] !== '"') return undefined

    const name = stringAt(source, index, close)
    if (name === undefined) return undefined

    const colon = skipSpace(source, name.end, close)
    if (source[colon] !== ':') return undefined

    const valueStart = skipSpace(source, colon + 1, close)
    const valueEnd = endOfValue(source, valueStart, close)
    if (valueEnd === undefined) return undefined

    if (name.value === key) return [valueStart, valueEnd]

    const next = skipSpace(source, valueEnd, close)
    if (next >= close) return undefined
    if (source[next] !== ',') return undefined
    index = next + 1
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
