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
 * hands the result to every `plan()` as a second argument — which is also what E3 (#28) needs,
 * since it has to know what it is wiring rather than re-deriving it.
 *
 * **Nothing here throws, and the rule is stricter than `plan()`'s.** A step that throws while
 * planning turns one repository's problem into a stack trace; this runs before every step, so
 * a `package.json` with a trailing comma four directories down would take out an init that had
 * nothing to do with it. Every read degrades to `undefined` — the same posture
 * `@dogear/vite`'s `app-name.ts` takes toward the same file format, for the same reason: a
 * broken manifest somewhere in a working tree is an ordinary thing to find.
 *
 * **Nothing here writes, and nothing here guesses on the user's behalf.** Detection reports;
 * `.gitignore`, the config file and (by E3) the agent wiring are what act. A wrong guess costs
 * a line of output, which is the whole reason it is safe to guess at all.
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
}

export interface Detection {
  readonly workspace: Workspace
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

export function detect(root: string): Detection {
  const manifest = readManifest(join(root, 'package.json'))
  const workspace = workspaceOf(root, manifest)

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

  return { workspace, packages: packageDirs?.length, apps }
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
  const manifest = nearestManifest(root, dir)
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
  }
}

/** The first `package.json` at or above `dir`, stopping at the repository root. */
function nearestManifest(root: string, dir: string): Manifest | undefined {
  const segments = dir === '' ? [] : dir.split('/')

  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const manifest = readManifest(join(root, ...segments.slice(0, depth), 'package.json'))
    if (manifest !== undefined) return manifest
  }

  return undefined
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

/** Backslashes to forward slashes, and no leading or trailing separator. */
function normalize(pattern: string): string {
  return pattern
    .split(sep)
    .join('/')
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '')
}
