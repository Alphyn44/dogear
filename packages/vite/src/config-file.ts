import { readFileSync } from 'node:fs'

import { CONFIG_FILE, configPathFor, QUEUE_DIR } from '@dogear/queue'

import type { Modifier } from './client.js'
import { MODIFIERS } from './client.js'
import { normaliseEndpoint } from './endpoint.js'

/**
 * Reading `<git-root>/.dogear/config.json` — E7 (#40), and the reader E4 (#29) shipped the
 * file without.
 *
 * `dogear init` has written this file since E4 and nothing has ever opened it. What arrives
 * here is therefore **user data in a committed file**, which is the whole reason this module
 * exists rather than a `JSON.parse` inline in ./index.ts: every value has to be checked, and
 * every rejection has to be *said*, because there is no second reader to complain to.
 *
 * **Nothing here throws, and that is not the same rule ./index.ts follows for its own
 * options.** A bad `dogear({ modifier: 'banana' })` throws at config time — it is the
 * author's own code, in the file they are editing, and a typo should be named loudly. This
 * file is committed and shared: whoever broke it is often not whoever is running the dev
 * server, so one person's typo must not stop everyone else's `npm run dev`. Same value, two
 * audiences — the split ./client.ts and core's `resolveOptions` already make one level down.
 *
 * A rejected key is **dropped**, never repaired by guessing, so the caller's `??` chain falls
 * through to the plugin option or the default exactly as if the key had been absent. That is
 * what keeps "an unset key falls to the default rather than being overwritten with one" true
 * for broken keys as well as missing ones.
 */

/**
 * The keys this file may carry — the brief's Config block, in full.
 *
 * Wider than {@link FileConfig} by three, and deliberately: `version` is the schema tag,
 * `app` is excluded because it is per Vite root while this file is per repo (C4's ambiguity),
 * and `agent` belongs to `dogear init` rather than the plugin. All three are *recognised*, so
 * a file carrying them is correct and must not be warned about — which is the only reason
 * this list is separate from the set below.
 */
const RECOGNISED = new Set([
  'version',
  'enabled',
  'modifier',
  'endpoint',
  'transform',
  'include',
  'exclude',
  'hosts',
  'agent',
  'app',
])

/** The only schema version that exists. Anything else is a file from a future dogear. */
const VERSION = 1

/**
 * What the file contributed, after validation — only the keys that survived.
 *
 * Every field optional, and absence is load-bearing: ./index.ts layers this under its plugin
 * options with `??`, so a key that is missing here falls through to the default rather than
 * to a value this module invented. `Object.keys()` on the result is therefore also the list
 * of what the file actually changed, which is what the confirmation line reports.
 *
 * `hosts` is the one field with no matching plugin option. It is repo-wide safety
 * configuration — F3's guard list — and the repo-wide committed file is where it belongs.
 */
export interface FileConfig {
  readonly enabled?: boolean
  readonly endpoint?: string
  readonly modifier?: Modifier
  readonly transform?: boolean
  readonly include?: readonly string[] | string
  readonly exclude?: readonly string[] | string
  readonly hosts?: readonly string[]
}

/**
 * Read and validate the project's config file, reporting anything wrong with it through
 * `warn`.
 *
 * The logger is injected rather than reached for, so this is testable without standing up a
 * dev server — ./index.ts passes `server.config.logger.warn`. Every message it emits is a
 * `[dogear] …` line a developer reads in a terminal while their dev server starts, which is
 * the only feedback channel this file will ever have.
 *
 * **An absent file is silent.** It is by far the commonest case — a repo that never ran
 * `dogear init` — and a warning on every dev server start for a file nobody asked for would
 * be noise, not news.
 */
export function readConfigFile(
  gitRoot: string,
  warn: (message: string) => void,
): FileConfig {
  const path = configPathFor(gitRoot)
  // Named relative to the repo in every message. The absolute path is noise in a terminal
  // whose cwd is already inside the repository, and `.dogear/config.json` is the name the
  // brief, `dogear init` and the `.gitignore` step all use.
  const label = `${QUEUE_DIR}/${CONFIG_FILE}`

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // ENOENT is the ordinary case and says nothing. Everything else — EACCES, EISDIR, a
    // path that is a directory — is a file that exists and cannot be read, which the
    // developer needs told, because the alternative is dogear silently ignoring settings
    // they can see on disk.
    if (isMissing(error)) return {}

    warn(`[dogear] could not read ${label}: ${messageOf(error)}. Using plugin options.`)
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch (error) {
    warn(
      `[dogear] ${label} is not valid JSON: ${messageOf(error)}. Using plugin options.`,
    )
    return {}
  }

  // `typeof null === 'object'`, and an array's numeric keys would read as no keys at all
  // rather than as an error. Both are rejected explicitly.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn(`[dogear] ${label} is not a JSON object. Using plugin options.`)
    return {}
  }

  const source = parsed as Record<string, unknown>

  // Warned about but not acted on. A config written by a newer dogear is far more likely to
  // carry a key this version simply ignores than to reinterpret one it already knows, so
  // refusing the whole file would cost a downgraded user every setting they have to protect
  // against a schema change that has never happened. Absent reads as `VERSION`: there has
  // never been a release that wrote this file without one.
  const version = source['version']
  if (version !== undefined && version !== VERSION) {
    warn(
      `[dogear] ${label} declares version ${JSON.stringify(version)}, and this dogear ` +
        `understands ${VERSION}. Reading the keys it recognises anyway.`,
    )
  }

  // Computed against RECOGNISED rather than against the keys below, so a correct file that
  // sets `app` or `agent` stays quiet. A misspelled key is otherwise the one config mistake
  // with no symptom at all — the value simply never applies.
  const unknown = Object.keys(source).filter((key) => !RECOGNISED.has(key))
  if (unknown.length > 0) {
    warn(
      `[dogear] ${label} has ${unknown.length === 1 ? 'an unrecognised key' : 'unrecognised keys'}: ` +
        `${unknown.join(', ')}. Ignored.`,
    )
  }

  const config: {
    -readonly [K in keyof FileConfig]: FileConfig[K]
  } = {}

  const enabled = source['enabled']
  if (enabled !== undefined) {
    if (typeof enabled === 'boolean') config.enabled = enabled
    else warn(badValue(label, 'enabled', 'true or false', enabled))
  }

  const endpoint = source['endpoint']
  if (endpoint !== undefined) {
    // Validated by *calling* `normaliseEndpoint` rather than by restating its rules. It
    // rejects the site root, a protocol-relative `//host`, and anything carrying a query or
    // fragment — three rules that would otherwise have to be duplicated here and kept in
    // step, which is the trap core's `resolveOptions` documents for this same field.
    //
    // It throws, and from a *file* that is the one thing this module may not do: `dogear
    // init` never validates what it writes, so an endpoint that cannot be used is ordinary
    // user data, and a dev server that dies on it fails the criterion this reader exists to
    // meet. Caught, reported, dropped — and ./index.ts then normalises the surviving value
    // for real, which is idempotent.
    if (typeof endpoint === 'string') {
      try {
        normaliseEndpoint(endpoint)
        config.endpoint = endpoint
      } catch (error) {
        warn(`[dogear] ${label}: ${messageOf(error).replace(/^dogear: /, '')} Ignored.`)
      }
    } else {
      warn(badValue(label, 'endpoint', 'a path string', endpoint))
    }
  }

  const modifier = source['modifier']
  if (modifier !== undefined) {
    if (isModifier(modifier)) config.modifier = modifier
    else warn(badValue(label, 'modifier', MODIFIERS.join(', '), modifier))
  }

  const transform = source['transform']
  if (transform !== undefined) {
    if (typeof transform === 'boolean') config.transform = transform
    else warn(badValue(label, 'transform', 'true or false', transform))
  }

  for (const key of ['include', 'exclude'] as const) {
    const value = source[key]
    if (value === undefined) continue

    const patterns = asPatterns(value)
    if (patterns !== undefined) config[key] = patterns
    else warn(badValue(label, key, 'a glob string or an array of them', value))
  }

  const hosts = source['hosts']
  if (hosts !== undefined) {
    if (Array.isArray(hosts)) {
      const strings = hosts.filter((entry): entry is string => typeof entry === 'string')

      // Dropped entry by entry rather than rejecting the list, because falling back to
      // DEFAULT_HOSTS on one bad entry would silently *re-widen* a list someone was
      // narrowing — the opposite of what they were doing. An empty array survives as an
      // empty array: "nowhere" is a legitimate thing to say, and `enabled: false` is the
      // clearer way to say it, so this one is honoured rather than second-guessed.
      const dropped = hosts.filter((entry) => typeof entry !== 'string')
      if (dropped.length > 0) {
        warn(
          `[dogear] ${label}: hosts must contain only strings. Ignored ` +
            `${dropped.map((entry) => JSON.stringify(entry)).join(', ')}.`,
        )
      }

      config.hosts = strings
    } else {
      warn(badValue(label, 'hosts', 'an array of host patterns', hosts))
    }
  }

  return config
}

/** One shape for every rejected value, so the terminal reads the same way each time. */
function badValue(
  label: string,
  key: string,
  expected: string,
  received: unknown,
): string {
  return (
    `[dogear] ${label}: ${key} must be ${expected}, received ` +
    `${JSON.stringify(received)}. Ignored.`
  )
}

function isModifier(value: unknown): value is Modifier {
  return typeof value === 'string' && MODIFIERS.includes(value as Modifier)
}

/**
 * Vite's `FilterPattern` also admits `RegExp`, which JSON cannot express — so a file can only
 * ever supply a string or an array of them, and anything else is rejected rather than handed
 * to `createFilter` to fail on later.
 */
function asPatterns(value: unknown): readonly string[] | string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as readonly string[]
  }
  return undefined
}

/**
 * dogear's copy of `stripBom`, and the same duplication the plugin already carries for
 * `Modifier` and `SENTINEL`.
 *
 * E4 added the original in `packages/cli/src/json-insert.ts` for exactly this reason: several
 * Windows editors write a leading U+FEFF and `JSON.parse` throws on it, so a perfectly valid
 * `config.json` would be reported as unreadable. That copy is unreachable from here —
 * `@dogear/cli` is a bin package with no `exports` field — and one line is not worth a new
 * shared module. It is stripped for the parse only; nothing here writes the file back.
 */
function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
}

/** Is this the "file is not there" error, as opposed to one worth reporting? */
function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
