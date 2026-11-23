/**
 * The production leak check — F2, and layer 4 of the brief's five.
 *
 * Pure functions only: no `process.exit`, no logging, no argv parsing. The CI gate is
 * `scripts/gate/no-leaks.test.ts`, which runs these under vitest — that is how the check
 * gets a runner without adding a dependency, and why "fails loudly, naming the file"
 * falls out of the assertion diff for free.
 *
 * The sentinel is imported from core's SOURCE by relative path rather than through the
 * package name. Going through `dogear-core` would hit the exports map, whose `default`
 * condition resolves to the noop — and the noop deliberately does not carry the sentinel.
 * The relative import also keeps this script build-independent, so `npm run typecheck`
 * never has to wait on `npm run build`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { SENTINEL } from '../packages/core/src/sentinel.js'

export interface Rule {
  /** Short identifier, shown in the failure report. */
  readonly name: string
  /** Literal substring searched for. Not a regex — these are exact markers. */
  readonly needle: string
  /** Why finding this is a bug. Printed on failure so the reader need not guess. */
  readonly why: string
}

export interface Finding {
  readonly rule: string
  /** Repo-relative, forward slashes, so reports read the same on every platform. */
  readonly file: string
  readonly detail: string
}

export interface ScanResult {
  /**
   * Text files actually read. The gate asserts this is greater than zero: a scan that
   * examined nothing has not passed, it has failed to run.
   */
  readonly filesScanned: number
  readonly findings: readonly Finding[]
}

/**
 * Every dogear package specifier, published or not.
 *
 * This list exists because G5's rename cost the gate its cheapest rule. The old needle was
 * the scope prefix `@dogear/`, which covered a package added later for free. Unscoped, the
 * equivalent prefix is `dogear-` — and that is a **substring of `data-dogear-src` and
 * `data-dogear-component`**, whose rules sit in the table below, so every fixture carrying
 * one attribute would report two findings. It is also a substring of the gated-import
 * fixture's marker, which would make this general rule shadow layer 2's bespoke one and
 * muddy which layer failed.
 *
 * So the rule names each package, and an explicit list is a list that can go stale:
 * `scripts/packaging.test.ts` asserts every published name appears here. `dogear-queue` is
 * in it too — it is never published, but it is inlined into all three bundles, so its
 * specifier surviving into production output means the same thing. J4 (#80) added
 * `dogear-next`, the second host, ahead of its publishing, because the gate scans a Next build
 * from J4 on; and `dogear-host`, which is inlined into both hosts as `dogear-queue` is.
 */
export const PACKAGE_SPECIFIERS = [
  'dogear-core',
  'dogear-vite',
  'dogear-next',
  'dogear-cli',
  'dogear-queue',
  'dogear-host',
] as const

export const RULES: readonly Rule[] = [
  {
    name: 'sentinel',
    needle: SENTINEL,
    why: 'dogear marks its dev-only code with this; in production output it means the overlay shipped',
  },
  {
    name: 'source-attribute',
    needle: 'data-dogear-src',
    why: "C1's JSX transform stamps this in dev only; production DOM must never carry it",
  },
  {
    // A separate literal rather than widening the rule above to `data-dogear`. That would
    // look like the tidier fix and would break the gate: examples/react-app renders the
    // text `<script data-dogear>` as prose explaining A1, so the shorter substring is
    // legitimately present in a healthy production build. Same trap as using the product
    // name — see the Decisions log.
    name: 'component-attribute',
    needle: 'data-dogear-component',
    why: "C5's JSX transform stamps this in dev only; production DOM must never carry it",
  },
  ...PACKAGE_SPECIFIERS.map((specifier) => ({
    name: 'package-specifier',
    needle: specifier,
    why: 'an unresolved import or a surviving sourcemap path — dogear was in the module graph',
  })),
]

/** Bytes inspected when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 1024

/** Characters of surrounding context included in a failure report. */
const EXCERPT_PADDING = 24

export interface ScanOptions {
  /**
   * Directory names, relative to the target, whose contents are not scanned. For output a
   * build keeps beside what it ships: `.next/cache` holds the compiler's own caches, and is
   * never deployed. A name, not a pattern, so the list says exactly what it leaves out.
   */
  readonly skip?: readonly string[]
}

/**
 * Recursively scan a build output directory (or a single file) for dogear markers.
 *
 * Throws when the target is missing. That is deliberate and is the single most important
 * behaviour here: silently returning "no findings" for a directory that was never built
 * would make this check go green forever the day somebody reorders the CI steps.
 *
 * **A source map is scanned without its `sourcesContent`** (J4, #80). That field is a verbatim
 * copy of the source the map describes, and Turbopack's production build emits server maps
 * that carry the app's own source in it (J1's spike found F1's layer 2 marker there and nowhere
 * else). The source is not output: what the build made of it is in the emitted file beside the
 * map, which is scanned as ever. Everything else in the map stays in, `sources` above all, so a
 * map path through `node_modules/dogear-core` is still the finding the package rule exists for.
 */
export function scanBuildOutput(
  target: string,
  rules: readonly Rule[] = RULES,
  options: ScanOptions = {},
): ScanResult {
  let stats
  try {
    stats = statSync(target)
  } catch {
    throw new Error(
      `check-leak: ${displayPath(target)} does not exist, so nothing was scanned. ` +
        'Build first. A leak check that scanned nothing is not a leak check that passed.',
    )
  }

  const skip = new Set((options.skip ?? []).map((dir) => join(target, dir)))
  const files = stats.isDirectory() ? walk(target, skip) : [target]
  const findings: Finding[] = []
  let filesScanned = 0

  for (const file of files) {
    const buffer = readFileSync(file)
    // Sniff for NUL bytes rather than filtering on extension. An extension allowlist
    // silently skips anything nobody thought of, which is the wrong failure mode for a
    // check whose entire job is catching the unexpected.
    if (isBinary(buffer)) continue

    filesScanned += 1
    const text = buffer.toString('utf8')
    const map = withoutEmbeddedSource(text)
    findings.push(
      ...(map === undefined
        ? scanText(text, file, rules)
        : scanText(map, file, rules, ' (a source map, scanned without sourcesContent)')),
    )
  }

  return { filesScanned, findings }
}

/**
 * The map re-serialised without `sourcesContent`, or `undefined` if `text` is not a source map.
 *
 * Recognised by content, not by a `.map` extension, for the reason binary files are: a rule
 * keyed on a name skips whatever nobody thought to name. The cheap test runs first, so ordinary
 * output is never handed to `JSON.parse`.
 */
function withoutEmbeddedSource(text: string): string | undefined {
  if (!text.trimStart().startsWith('{') || !text.includes('"sourcesContent"'))
    return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined
  const { sourcesContent, ...rest } = parsed as Record<string, unknown>
  if (!Array.isArray(sourcesContent)) return undefined

  return JSON.stringify(rest)
}

/**
 * The other half of layer 4: dogear must appear in `devDependencies` and nowhere else.
 * A production `dependencies` entry is a leak the content grep cannot see, because the
 * bundle can be perfectly clean while the package still installs in production.
 */
export function scanManifest(manifestPath: string): Finding[] {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }

  return (
    Object.keys(manifest.dependencies ?? {})
      // `dogear` is not one of ours — it is an unrelated hapi plugin — but a manifest that
      // depends on it in production is either a typo for one of these or something nobody
      // meant, and the check is deliberately conservative about which.
      .filter(
        (name) =>
          name === 'dogear' || (PACKAGE_SPECIFIERS as readonly string[]).includes(name),
      )
      .map((name) => ({
        rule: 'runtime-dependency',
        file: displayPath(manifestPath),
        detail: `"${name}" is listed in dependencies — dogear must only ever be a devDependency`,
      }))
  )
}

/**
 * Render findings for a human. Returns the empty string when there is nothing wrong,
 * which lets the gate assert `toBe('')` and get the whole report as its failure diff.
 */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return ''

  const lines = [
    '',
    `dogear leaked into build output — ${findings.length} finding(s):`,
    '',
    ...findings.flatMap((finding) => [
      `  ${finding.file}`,
      `    [${finding.rule}] ${finding.detail}`,
    ]),
    '',
    'This build is not safe to ship. `apply: "serve"` or `withDogear`\'s phase check (layer 1)',
    'and the exports map (layer 3) are what should have prevented it; check those before',
    'adjusting this check.',
    '',
  ]

  return lines.join('\n')
}

/**
 * @param note  Appended to the file in the report when what was scanned is not the file's own
 *   bytes, so an offset that does not match the file on disk explains itself.
 */
function scanText(
  text: string,
  file: string,
  rules: readonly Rule[],
  note = '',
): Finding[] {
  const findings: Finding[] = []

  for (const rule of rules) {
    const offset = text.indexOf(rule.needle)
    if (offset === -1) continue

    const occurrences = countOccurrences(text, rule.needle)
    findings.push({
      rule: rule.name,
      file: displayPath(file),
      detail:
        `${occurrences}× "${rule.needle}", first at byte ${offset}${note} — ${rule.why}` +
        `\n           …${excerpt(text, offset, rule.needle.length)}…`,
    })
  }

  return findings
}

function walk(dir: string, skip: ReadonlySet<string>): string[] {
  const found: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skip.has(full)) found.push(...walk(full, skip))
    } else if (entry.isFile()) found.push(full)
  }

  // Sorted so a failure report is stable across machines and reruns.
  return found.sort()
}

function isBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let index = text.indexOf(needle)

  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }

  return count
}

function excerpt(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - EXCERPT_PADDING)
  const end = Math.min(text.length, offset + length + EXCERPT_PADDING)
  return text.slice(start, end).replace(/\s+/g, ' ')
}

function displayPath(file: string): string {
  const rel = relative(process.cwd(), file)
  return (rel.startsWith('..') ? file : rel).split(sep).join('/')
}
