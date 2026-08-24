import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * What `dogear init` works out about a repository before it changes anything — E2 (#27).
 *
 * **This is a phase, not a {@link import('./scaffold.js').Step}.** ./scaffold.ts's header used
 * to say E2 would prepend a step, and that was wrong for a reason worth recording: a step
 * speaks through `Plan.notes`, and notes print *after* the change list. #27's second
 * acceptance criterion is that init reports what it found *before* it changes anything, so a
 * detection step would have satisfied the letter of the first criterion and inverted the
 * second. Detection therefore runs ahead of planning, gets its own section in the report, and
 * hands the result to every `plan()` as a second argument. E3 (#28) reads it earlier still —
 * ../src/scaffold.ts reconciles it with the flags into a `Wiring` before any step is built,
 * because a step cannot say what it would do until it knows which agent it is wiring.
 *
 * **Nothing here throws, and the rule is stricter than `plan()`'s.** A step that throws while
 * planning turns one repository's problem into a stack trace; this runs before every step, so
 * a `package.json` with a trailing comma four directories down would take out an init that had
 * nothing to do with it. Every read degrades to `undefined` — the same posture
 * `dogear-vite`'s `app-name.ts` takes toward the same file format, for the same reason: a
 * broken manifest somewhere in a working tree is an ordinary thing to find.
 *
 * **Nothing here writes, and nothing here guesses on the user's behalf.** Detection reports;
 * `.gitignore`, the config file and E3's agent wiring are what act. A wrong guess costs a line
 * of output, which is the whole reason it is safe to guess at all — and since E3 that guess
 * decides what gets written to the user's agent configuration, which is what `--agent` and
 * `--dry-run` exist to keep answerable.
 *
 * **Versions are the declared range, verbatim** — `react ^19.2.0`, never `19.2.1` resolved out
 * of `node_modules`. The manifest is what the repository says about itself and it is there
 * before `npm install` is; reading the installed tree would make the report depend on whether
 * someone had run an install yet, and would report a version the repo never asked for.
 */

export type Framework = 'preact' | 'solid' | 'svelte' | 'vue' | 'react'

/**
 * How the repository organises its packages.
 *
 * `npm` and `yarn` both mean a `workspaces` array in the root manifest — they are told apart
 * by the lockfile, and only so the report can use the word the user would. `pnpm` means a
 * `pnpm-workspace.yaml`; see {@link Detection.packages} for what that costs.
 */
export type Workspace = 'npm' | 'yarn' | 'pnpm' | 'single'

/**
 * Which tool installs things here, from the lockfile at the root.
 *
 * **Separate from {@link Workspace} rather than folded into it** — E8 (#41). That type answers
 * "how are the packages organised", and its `npm`/`yarn` split is a lockfile question wearing a
 * layout question's clothes. A single-package pnpm repository is the case that forces them
 * apart: its layout is `single`, which says nothing at all about the manager, and E8 prints an
 * install command that would be wrong for it.
 */
export type Manager = 'npm' | 'yarn' | 'pnpm'

/** Where a package is declared in a manifest, if it is. */
export type Declaration = 'dev' | 'runtime' | 'absent'

/**
 * A coding agent `dogear init` knows how to wire — E3 (#28).
 *
 * The three that register an MCP server through a **project-local JSON file**, which is what
 * makes them one mechanism rather than three. Codex is the notable absence: its registration
 * lives in `~/.codex/config.toml`, which is global, outside the repository, and TOML — a file
 * E6's per-repo undo could not reach and a format the CLI has no parser for. The brief's
 * "Still open" already flags the global-config question as needing thought of its own.
 */
export type Agent = 'claude' | 'cursor' | 'vscode'

/** An agent this repository shows signs of using, and what gave it away. */
export interface DetectedAgent {
  readonly agent: Agent
  /** The marker that proved it — repository-relative and forward-slashed. */
  readonly marker: string
}

/** Whether `dogear-cli` is reachable from inside the repository. */
export type Cli = 'local' | 'absent'

/** One directory with a Vite config in it — an app, as far as init is concerned. */
export interface DetectedApp {
  /** Repository-relative and forward-slashed. `''` is the repository root itself. */
  readonly dir: string
  /** Repository-relative path of the Vite config that made this a candidate. */
  readonly config: string
  readonly framework: Framework | undefined
  /** The declared range, verbatim — `^19.2.0`. `undefined` when nothing declares it. */
  readonly frameworkVersion: string | undefined
  readonly viteVersion: string | undefined
  /**
   * Repository-relative directory of the manifest this app's dependencies belong to — the
   * nearest `package.json` at or above {@link DetectedApp.dir}. `''` is the root, `undefined`
   * when the repository has no manifest anywhere above the app.
   *
   * Not the same as `dir`, and E8 (#41) is why it is reported separately: it prints the
   * directory to run an install in, and an app scaffolded into a subdirectory of an existing
   * package would otherwise be told to install somewhere that would grow a stray manifest.
   * The framework above is read from this same file, so the two can never disagree about which
   * package an app belongs to.
   */
  readonly manifestDir: string | undefined
  /**
   * Whether that manifest declares `dogear-vite`, and in which field — E8 (#41).
   *
   * `runtime` is not merely unusual, it is the manifest half of the production leak
   * `scripts/check-leak.ts` exists to catch: a dev-only plugin in `dependencies` installs in
   * production even when every bundle is clean. init reports it and does not move it.
   */
  readonly plugin: Declaration
  /**
   * Whether {@link DetectedApp.config} mentions dogear at all — G3 (#44).
   *
   * {@link DetectedApp.plugin} is a *manifest* fact and this is a *config* fact, and the
   * install path needs both: `npm i -D dogear-vite` makes the first true and changes nothing
   * about the second. G3 walked into exactly that gap — the package installed, `dogear()` not
   * in the `plugins` array, and `dogear init` reporting `nothing changed` with no snippet,
   * because guidance keyed on the declaration alone. The overlay never loads in that state.
   *
   * **A substring test, deliberately not a parse.** ./guidance.ts refuses to *rewrite* a
   * config because doing that safely means parsing it and a wrong guess is a dev server that
   * will not start. Deciding whether to *print a hint* is a far cheaper question, and it fails
   * cheaply in both directions: a stray mention in a comment costs a suppressed hint, and a
   * missed one costs a redundant hint next to a config that already works. An unreadable
   * config is `false`, which is the direction that prints.
   */
  readonly configured: boolean
}

export interface Detection {
  readonly workspace: Workspace
  /** Which tool installs here. `npm` when no lockfile answers — see {@link Manager}. */
  readonly manager: Manager
  /**
   * How many packages the workspace globs resolved to. `1` for a single-package repository.
   *
   * **`undefined` means "a workspace whose package list was not read"**, which today is
   * exactly the pnpm case: its globs live in `pnpm-workspace.yaml`, and parsing that would mean
   * either a YAML dependency — the CLI has one dependency and it is the MCP SDK — or a
   * hand-rolled parser that will eventually meet YAML it does not understand. The layout is
   * still named in the report; only the count is missing, and the bounded walk still finds the
   * apps. Callers must not print `undefined packages`.
   */
  readonly packages: number | undefined
  readonly apps: readonly DetectedApp[]
  /**
   * Agents this repository shows signs of using — E3 (#28), in marker order.
   *
   * **Empty is an ordinary answer, not a failure.** A fresh clone has no `.claude/` and no
   * `.cursor/`, and E3 still registers the MCP server there: `.mcp.json` at the root is the
   * closest thing to a portable default, and a baseline path that skipped the commonest
   * fresh-clone case would not be a baseline. What this list changes is the *extra* files —
   * Cursor's and VS Code's — which are written only where something says they are wanted.
   */
  readonly agents: readonly DetectedAgent[]
  /**
   * Whether `dogear-cli` is installed in, or declared by, this repository — E3 (#28).
   *
   * The agent configs `dogear init` writes name `node_modules/dogear-cli/dist/cli.js`, which
   * is repo-relative so that the file stays correct for everyone who clones. That path is
   * written whatever this says; `absent` earns a `Plan.note` telling the user to install it,
   * because the alternative — resolving the *global* install and writing an absolute path into
   * a committed file — is broken for every other machine the moment it lands.
   */
  readonly cli: Cli
}

/** Every filename Vite itself will load a config from. */
const CONFIG_NAMES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
] as const

/**
 * The package that identifies each framework, in resolution order.
 *
 * **Order is load-bearing at the top of the list.** A Preact app under the
 * `preact/compat` alias declares `react` too, so a react-first scan would report every Preact
 * app as React. The reverse mistake is not available — a React app does not depend on Preact.
 */
const FRAMEWORK_PACKAGES: readonly (readonly [Framework, string])[] = [
  ['preact', 'preact'],
  ['solid', 'solid-js'],
  ['svelte', 'svelte'],
  ['vue', 'vue'],
  ['react', 'react'],
]

/**
 * Directories the walk never descends into.
 *
 * `node_modules` is the one that matters: virtually every dependency tree contains a
 * `vite.config.*` in some package's fixtures, and finding one would report a phantom app in a
 * directory the user does not own. The rest are build output — a `dist/` holding a copied
 * config is noise, not an app.
 */
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage'])

/**
 * How far below the root the walk looks, root being depth 0.
 *
 * Three covers `apps/web`, `packages/ui/playground` and every layout in between. It is a cap
 * rather than an exhaustive search because this runs on a repository of unknown size while a
 * human waits, and because the layouts deep enough to escape it — `projects/frontend/apps/web`
 * — are nearly always workspaces, where the globs are read instead and the walk never runs.
 */
const MAX_DEPTH = 3

/** The package `dogear init` tells people to install. */
const PLUGIN = 'dogear-vite'

/** The package whose `dist/cli.js` every config init writes points at. */
const CLI = 'dogear-cli'

/**
 * Where a local `dogear-cli` puts the file every agent config init writes points at.
 *
 * **Repo-relative, and never the resolved global install** — E3 (#28). These configs are
 * committed, so an absolute path out of one developer's npm prefix is broken for everyone else
 * the moment it lands. Written whether or not the package is installed yet; see
 * {@link Detection.cli} for what init says when it is not.
 *
 * **`node <path>`, never `dogear`.** A global npm bin on Windows is a `.cmd` shim, and the exec
 * form these configs use cannot run one. Same rule as the `UserPromptSubmit` hook, from the
 * brief's Delivery section.
 */
export const CLI_ENTRY = 'node_modules/dogear-cli/dist/cli.js'

/**
 * What proves an agent is in use here — E3 (#28), first match wins per agent.
 *
 * **Directories, mostly, and deliberately loose.** These answer "is this tool used in this
 * repository", not "is this tool configured for MCP" — the second question is what init is
 * about to fix, so detecting on it would mean only ever wiring what was already wired.
 *
 * The imprecision is real and worth naming: `.vscode/` exists in a great many repositories
 * whose owners have never used an agent, so a `.vscode/mcp.json` may land somewhere it is
 * simply inert. That is the cost of having no better signal, and it is bounded — the file is
 * small, repo-local, ignored by everything that does not read it, and removed by `--undo`.
 * `--agent` is the escape hatch for anyone who wants it not to happen.
 */
const MARKERS: readonly (readonly [Agent, string, 'dir' | 'file'])[] = [
  ['claude', '.claude', 'dir'],
  ['claude', '.mcp.json', 'file'],
  ['claude', 'CLAUDE.md', 'file'],
  ['cursor', '.cursor', 'dir'],
  ['vscode', '.vscode', 'dir'],
]

export function detect(root: string): Detection {
  const manifest = readManifest(join(root, 'package.json'))
  const workspace = workspaceOf(root, manifest)
  const manager = managerOf(root)

  // Only the `workspaces` array is readable, so only npm and yarn get the guided path. pnpm
  // and single-package repositories fall to the walk, which is also what makes a pnpm repo
  // report its apps despite its package count being unknown.
  const packageDirs =
    workspace === 'npm' || workspace === 'yarn'
      ? resolvePatterns(root, patternsIn(manifest))
      : undefined

  // The root is always a candidate. A repository whose Vite app *is* the repository is the
  // ordinary single-package case, and a monorepo with a demo app at the root is unusual but
  // real — neither is served by only looking at the workspace members.
  const candidates = packageDirs === undefined ? walk(root) : ['', ...packageDirs]

  const apps = candidates
    .map((dir) => appAt(root, dir))
    .filter((app): app is DetectedApp => app !== undefined)

  return {
    workspace,
    manager,
    packages: packageDirs?.length,
    apps,
    agents: agentsIn(root),
    cli: cliIn(root, manifest),
  }
}

/**
 * Which agents this repository shows signs of using — E3 (#28).
 *
 * One entry per agent, carrying the *first* marker that matched, so the report can say what it
 * saw rather than merely what it concluded. A repository that has both `.claude/` and
 * `CLAUDE.md` is reported once, on the directory.
 */
function agentsIn(root: string): readonly DetectedAgent[] {
  const found: DetectedAgent[] = []

  for (const [agent, marker, kind] of MARKERS) {
    if (found.some((entry) => entry.agent === agent)) continue

    const path = join(root, marker)
    const present = kind === 'dir' ? isDirectory(path) : isFile(path)
    if (present) found.push({ agent, marker: kind === 'dir' ? `${marker}/` : marker })
  }

  return found
}

/**
 * Is `dogear-cli` reachable from inside this repository?
 *
 * **Two questions, either of which is a yes**, and they are not redundant. The file on disk is
 * the state that makes the written config work *today*; the manifest declaration is the state
 * that makes it work after the next `npm ci` on a machine that has not installed yet. A
 * repository that declares it but has not installed is mid-clone, not misconfigured, and does
 * not need telling.
 */
function cliIn(root: string, manifest: Manifest | undefined): Cli {
  if (isFile(join(root, ...CLI_ENTRY.split('/')))) return 'local'
  return declarationOf(manifest, CLI) === 'absent' ? 'absent' : 'local'
}

/**
 * Which tool installs here, from the lockfile at the root.
 *
 * **npm is the fallback, not a detection.** A repository with no lockfile has not installed
 * anything yet, and there is nothing to read; npm is the floor this project targets and the
 * command most users can translate. Checked in this order because a repository that migrated
 * between managers keeps the old lockfile more often than it deletes it, and pnpm's and yarn's
 * are the ones deliberately adopted.
 */
function managerOf(root: string): Manager {
  if (isFile(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (isFile(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/** Which layout, from the root manifest and the lockfiles beside it. */
function workspaceOf(root: string, manifest: Manifest | undefined): Workspace {
  // Checked before `workspaces`, because a pnpm repository's root manifest may carry both — a
  // leftover `workspaces` array is inert under pnpm, and reading it would report a package
  // count pnpm is not using.
  if (
    isFile(join(root, 'pnpm-workspace.yaml')) ||
    isFile(join(root, 'pnpm-workspace.yml'))
  ) {
    return 'pnpm'
  }

  if (patternsIn(manifest).length === 0) return 'single'

  return isFile(join(root, 'yarn.lock')) ? 'yarn' : 'npm'
}

/**
 * The `workspaces` field, as a list of patterns.
 *
 * Yarn's object form — `{ "packages": [...] }` — is accepted alongside npm's plain array,
 * because a repository using it is a repository with workspaces whatever this function
 * believes. Anything else reads as no workspaces at all rather than as an error: this is a
 * detector, and a manifest it cannot understand is a repository it reports less about.
 */
function patternsIn(manifest: Manifest | undefined): readonly string[] {
  const field = manifest?.workspaces

  const raw = Array.isArray(field)
    ? field
    : typeof field === 'object' &&
        field !== null &&
        Array.isArray((field as Yarn).packages)
      ? (field as Yarn).packages
      : []

  return (raw ?? []).filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Turn workspace patterns into the directories that actually hold a `package.json`.
 *
 * **Deliberately not a glob matcher.** Workspace patterns in the wild are `packages/*`,
 * `apps/**`, the odd literal path and the occasional `!packages/legacy` — directory prefixes,
 * not filename patterns. Handling those four shapes is a dozen lines; handling the general
 * case is a dependency, and one whose failure mode here is a wrong package *count* in a
 * report. A pattern this does not understand contributes nothing, which under-reports rather
 * than inventing packages.
 */
function resolvePatterns(root: string, patterns: readonly string[]): readonly string[] {
  const excluded = new Set<string>()
  const included: string[] = []

  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    const body = normalize(negated ? pattern.slice(1) : pattern)
    const target = negated ? [...excluded] : included

    for (const dir of expand(root, body)) {
      if (negated) excluded.add(dir)
      else if (!included.includes(dir)) target.push(dir)
    }
  }

  return included.filter(
    (dir) => !excluded.has(dir) && isFile(join(root, dir, 'package.json')),
  )
}

/** One pattern's directories, relative and forward-slashed. */
function expand(root: string, pattern: string): readonly string[] {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return walk(join(root, prefix)).map((dir) =>
      dir === '' ? prefix : `${prefix}/${dir}`,
    )
  }

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return childrenOf(join(root, prefix)).map((name) => `${prefix}/${name}`)
  }

  // A literal path. `*` anywhere else is a shape this does not read; see the header.
  return pattern.includes('*') ? [] : [pattern]
}

/**
 * Every directory at or below `from`, relative and forward-slashed, `''` first.
 *
 * Depth-first and bounded by {@link MAX_DEPTH}. A directory it cannot read contributes
 * nothing — a permissions-managed tree is a thing to walk past, not to fail an init over.
 */
function walk(from: string): readonly string[] {
  const found: string[] = ['']

  const descend = (relativeDir: string, depth: number): void => {
    if (depth >= MAX_DEPTH) return

    for (const name of childrenOf(join(from, relativeDir))) {
      const next = relativeDir === '' ? name : `${relativeDir}/${name}`
      found.push(next)
      descend(next, depth + 1)
    }
  }

  descend('', 0)
  return found
}

/** Sub-directory names worth descending into. Never throws; an unreadable directory is empty. */
function childrenOf(dir: string): readonly string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && !SKIP.has(name))
}

/** The app in `dir`, or `undefined` if there is no Vite config there. */
function appAt(root: string, dir: string): DetectedApp | undefined {
  const absolute = dir === '' ? root : join(root, dir)
  const name = CONFIG_NAMES.find((candidate) => isFile(join(absolute, candidate)))
  if (name === undefined) return undefined

  // The nearest manifest, not the root's: in a workspace the app's own `package.json` is what
  // declares its framework, and two apps in one repository routinely declare different ones.
  // Walking up from there is what covers an app directory that has no manifest of its own.
  const nearest = nearestManifest(root, dir)
  const manifest = nearest?.manifest
  const framework = FRAMEWORK_PACKAGES.find(
    ([, pkg]) => versionOf(manifest, pkg) !== undefined,
  )

  return {
    dir,
    config: dir === '' ? name : `${dir}/${name}`,
    framework: framework?.[0],
    frameworkVersion:
      framework === undefined ? undefined : versionOf(manifest, framework[1]),
    viteVersion: versionOf(manifest, 'vite'),
    manifestDir: nearest?.dir,
    plugin: declarationOf(manifest, PLUGIN),
    configured: mentionsDogear(join(absolute, name)),
  }
}

/**
 * Does this Vite config reference dogear? See {@link DetectedApp.configured} for why a
 * substring is the right instrument here and a parse is not.
 *
 * Word-bounded so `dogeared` and `undogear` do not count, and case-insensitive because the
 * import specifier, the plugin call and a comment may each spell it differently. Never throws
 * — detection runs before every step.
 *
 * **A hyphen is a word boundary, so `dogear-vite` matches, and it must.** Since G5 (#50) the
 * package is named exactly that, so the specifier a wired config imports from is a hyphenated
 * segment. An earlier version of this comment claimed the word boundary excluded
 * `not-dogear-related`; it never did, and "fixing" the regex to honour that claim would make
 * {@link DetectedApp.configured} report `false` for every correctly wired repository.
 */
function mentionsDogear(path: string): boolean {
  try {
    return /\bdogear\b/i.test(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

/**
 * The first `package.json` at or above `dir`, with the directory holding it.
 *
 * The directory comes back alongside the contents because E8 (#41) has to name it — it prints
 * the directory to run an install in — and deriving it a second time from the same walk is how
 * two answers about the same file drift apart.
 */
function nearestManifest(
  root: string,
  dir: string,
): { readonly dir: string; readonly manifest: Manifest } | undefined {
  const segments = dir === '' ? [] : dir.split('/')

  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const at = segments.slice(0, depth)
    const manifest = readManifest(join(root, ...at, 'package.json'))
    if (manifest !== undefined) return { dir: at.join('/'), manifest }
  }

  return undefined
}

/** Which dependency map declares `name`, if either does. Runtime wins, as npm resolves it. */
function declarationOf(manifest: Manifest | undefined, name: string): Declaration {
  if (isDeclared(manifest?.dependencies, name)) return 'runtime'
  if (isDeclared(manifest?.devDependencies, name)) return 'dev'
  return 'absent'
}

/**
 * Declared at all — the *presence of the key*, not a usable range.
 *
 * Deliberately weaker than {@link versionOf}, which requires a non-empty string. A key whose
 * value is empty or malformed is still someone having declared the dependency on purpose, and
 * telling them to install a package their own manifest already names is the wrong correction
 * to make. `hasOwnProperty` rather than a truthiness check for the same reason.
 */
function isDeclared(map: Record<string, unknown> | undefined, name: string): boolean {
  return map !== undefined && Object.prototype.hasOwnProperty.call(map, name)
}

/** A dependency's declared range, from either map. Runtime deps win, as npm resolves them. */
function versionOf(manifest: Manifest | undefined, name: string): string | undefined {
  for (const map of [manifest?.dependencies, manifest?.devDependencies]) {
    const value = map?.[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }

  return undefined
}

/** Only the fields detection reads. Everything is optional because nothing is trusted. */
interface Manifest {
  readonly workspaces?: unknown
  readonly dependencies?: Record<string, unknown>
  readonly devDependencies?: Record<string, unknown>
}

interface Yarn {
  readonly packages?: readonly unknown[]
}

/** A parsed manifest, or `undefined` for absent, unreadable, unparseable, or not an object. */
function readManifest(path: string): Manifest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }

  return typeof parsed === 'object' && parsed !== null ? (parsed as Manifest) : undefined
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Backslashes to forward slashes, and no leading or trailing separator. */
function normalize(pattern: string): string {
  return pattern
    .split(sep)
    .join('/')
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '')
}
