import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { tempPathFor } from './queue.js'

/**
 * Reading and writing `~/.dogear/projects.json` — the machine-level registry behind
 * `dogear status` (E5, #30).
 *
 * **Why this lives in a package named for the queue.** The registry is not the queue, but it
 * has the queue's two consumers and the queue's two concurrency rules: `@dogear/vite` writes
 * it, `@dogear/cli` reads it, and neither can import the other. That is the same argument
 * that created this package during D1, and it reaches the registry unchanged — two
 * implementations of one file format disagreeing is how a user's state gets lost silently.
 * A fifth workspace for eighty lines is the thing this repository has now argued against
 * twice.
 *
 * ---
 *
 * **This file is per *machine*; ./queue.ts is per *repository*.** They share the directory
 * name `.dogear` and nothing else — one hangs off the home directory, the other off the git
 * root. {@link REGISTRY_DIR} is therefore its own constant rather than an alias of
 * `QUEUE_DIR`: collapsing them would tie two unrelated relocations together, and a future
 * `~/.dogear/config.json` (the brief's machine-level prefs, still unbuilt) anchors here too.
 *
 * ---
 *
 * **Two writers, and they write different halves of an entry.**
 *
 * - `dogear init` calls {@link registerProject}: this repo exists, here is when it was set
 *   up. It knows no origin and never will — there is no dev server when init runs.
 * - The **plugin** calls {@link registerServer} once its HTTP server is listening, which is
 *   the first moment the port is known. Vite bumps the port when the configured one is
 *   taken, so nothing available earlier is the truth.
 *
 * Either may create the entry. A repository that was wired by hand and never init'd still
 * shows up in `dogear status`, which is the point of showing it at all.
 *
 * **Entries are keyed by {@link registryKey}, not by the raw path.** Two processes on
 * Windows routinely disagree about the drive letter's case for one repository — `init` from
 * a shell and Vite from an npm script are exactly that pair — and two spellings of one root
 * would be two entries for one repo. The writer's own spelling is preserved in `root` for
 * display, and the *creator's* spelling wins: later writers leave it alone rather than
 * fighting over it.
 *
 * ---
 *
 * **The concurrency rules are ./queue.ts's, for the same reason and with the same limits.**
 * Every mutation below re-reads immediately before writing, and the temp file carries the pid
 * — {@link tempPathFor} is imported rather than reimplemented. Several dev servers starting
 * at once is the ordinary case here, not the exotic one. As with the queue this does not make
 * concurrent writes safe: two writers can still interleave between the read and the rename
 * and the later one wins. The failure is a lost registration, healed the next time that dev
 * server starts, rather than a corrupted file.
 *
 * `writeRegistry` is deliberately **not exported**. The queue exports its equivalent because
 * `appendToQueue` and `pruneQueue` are not its only writers; here they are, and keeping the
 * raw write private is what makes "read-modify-write" unhoistable rather than merely
 * documented.
 *
 * ---
 *
 * **Reads may tolerate, writes must refuse** — the rule ./queue.ts states, applied the same
 * way. {@link readRegistry} throws and is what every writer here uses. {@link tryReadRegistry}
 * never throws and drops entries it cannot understand, so its result must never be written
 * back: doing so would delete the dropped entries.
 */

/**
 * The machine-level directory, under the home directory.
 *
 * Same name as `QUEUE_DIR` and deliberately not the same constant — see the header.
 */
export const REGISTRY_DIR = '.dogear'

export const REGISTRY_FILE = 'projects.json'

/** The only registry schema version that exists. */
export const REGISTRY_VERSION = 1

/**
 * The environment keys this module reads, named individually rather than taken as
 * `ProcessEnv` — the shape ./hook.ts's `HookEnv` established, for the same reason: a
 * function that declares the two variables it reads is testable with an object literal.
 */
export interface RegistryEnv {
  /**
   * Overrides the home directory the registry hangs off.
   *
   * Every suite that touches the registry needs this: without it, running the tests writes
   * into the developer's real `~/.dogear/projects.json` and CI's. It is a genuine escape
   * hatch too, for a machine whose home directory is not where state belongs.
   */
  readonly DOGEAR_HOME?: string | undefined
}

/** One dev server, as recorded at the moment it started listening. */
export interface ServerRecord {
  /** `http://localhost:5173` — no trailing slash, built from the *listening* port. */
  readonly origin: string
  /**
   * The dev server process.
   *
   * This is how `dogear status` answers "is it running" without a network call: a signal-0
   * probe costs nothing, needs no timeout, and cannot be confused by a busy server. See
   * {@link isProcessAlive}.
   */
  readonly pid: number
  /** C4's workspace package name, when the plugin resolved one. */
  readonly app?: string | undefined
  readonly startedAt: string
}

export interface Project {
  /**
   * The root as its creator spelled it, for display only. Never the identity — see
   * {@link registryKey}.
   */
  readonly root: string
  /** Absent for a repository the plugin registered without `dogear init` ever running. */
  readonly initialisedAt?: string | undefined
  readonly servers: readonly ServerRecord[]
}

export interface Registry {
  readonly version: number
  /** `null` only for a registry that has never been written. */
  readonly updatedAt: string | null
  readonly projects: Readonly<Record<string, Project>>
}

/**
 * Either the registry, or why there isn't one.
 *
 * Unlike the queue's equivalent, a `reason` here **is** for the user: `dogear status` is a
 * command a human typed, and a registry it cannot read means it can show nothing at all.
 */
export type RegistryRead =
  | { readonly ok: true; readonly registry: Registry }
  | { readonly ok: false; readonly reason: string }

/** What {@link registerServer} is given; `startedAt` is stamped by the write. */
export type ServerInput = Omit<ServerRecord, 'startedAt'>

/** `$DOGEAR_HOME`, or `~/.dogear`. */
export function registryHome(env: RegistryEnv = process.env): string {
  const override = env.DOGEAR_HOME?.trim()
  // Resolved, because a relative override would mean something different to the plugin (whose
  // cwd is wherever npm started it) than to the CLI (wherever the user is standing) — which is
  // the same class of bug `registryKey` exists to prevent.
  if (override !== undefined && override !== '') return resolve(override)

  return join(homedir(), REGISTRY_DIR)
}

export function registryPath(env: RegistryEnv = process.env): string {
  return join(registryHome(env), REGISTRY_FILE)
}

/**
 * The identity of a repository in this file.
 *
 * Forward slashes and an upper-cased drive letter, which between them remove the two ways
 * one repository gets two entries:
 *
 * - **Drive-letter case.** Node reports `c:\…` or `C:\…` depending on how the process was
 *   started, and `dogear init` typed into a shell and a Vite server spawned by npm land on
 *   opposite sides of that routinely. This is the failure the whole function exists for.
 * - **Separators.** `resolve()` gives backslashes on Windows, but a path that reached us
 *   through a config file or a URL may not have them, and JSON object keys compare byte for
 *   byte.
 *
 * Nothing else is normalised, and the rest of the path is **not** lower-cased: directory
 * names are the user's, they are displayed back, and Windows preserves their case even
 * though it ignores it. `realpathSync` was rejected — it would canonicalise symlinks too,
 * but it touches the filesystem on every read and *throws* for a root that no longer exists,
 * which is exactly the state `dogear status` has to survive and report.
 */
export function registryKey(root: string): string {
  const forward = resolve(root).replaceAll('\\', '/')

  return forward.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}

/**
 * `~/.dogear/projects.json` when the path is under the home directory, else the path itself.
 *
 * Presentation only, and used by both CLI surfaces that name this file. `~` is not something
 * a Windows shell expands, but it is still the clearest way to write "in your home
 * directory" in a sentence a human reads.
 */
export function shortenHome(path: string): string {
  const home = homedir()
  if (!path.startsWith(home)) return path

  const rest = path.slice(home.length).replaceAll('\\', '/')

  return rest.startsWith('/') ? `~${rest}` : path
}

/**
 * Read the registry, treating "no file yet" as an empty one — a machine where no repository
 * has been init'd is the state everyone starts in, not an error.
 *
 * Everything else throws, exactly as `readQueue` does and for the same reason: a file that
 * exists but cannot be understood is not an empty registry, and the next thing a writer would
 * do is overwrite it.
 *
 * **This is the reader every writer must use.** See the header.
 */
export function readRegistry(path: string): Registry {
  if (!existsSync(path)) {
    return { version: REGISTRY_VERSION, updatedAt: null, projects: {} }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    // Every message names the path, because `tryReadRegistry` surfaces them verbatim and a
    // reason without a path is not actionable.
    throw new Error(`${path} could not be read: ${messageOf(cause)}`, { cause })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`${path} exists but is not valid JSON`, { cause })
  }

  if (!isObject(parsed)) {
    throw new Error(`${path} is not a registry object`)
  }

  const registry = parsed as {
    version?: unknown
    updatedAt?: unknown
    projects?: unknown
  }

  if (registry.version !== REGISTRY_VERSION) {
    throw new Error(
      `${path} declares schema version ${JSON.stringify(registry.version)}, but this ` +
        `build only understands ${REGISTRY_VERSION}. Refusing to overwrite it.`,
    )
  }

  if (!isObject(registry.projects)) {
    throw new Error(`${path} has no projects object`)
  }

  return {
    version: REGISTRY_VERSION,
    updatedAt: typeof registry.updatedAt === 'string' ? registry.updatedAt : null,
    projects: registry.projects as Record<string, Project>,
  }
}

/**
 * Read the registry, degrading to a reason rather than throwing, and dropping entries that
 * are not project-shaped.
 *
 * Built on {@link readRegistry} so the two can never disagree about the envelope. The
 * per-entry tolerance is what a read-only caller wants: one hand-broken entry should cost
 * that repository's line, not the other nine. That is also exactly why **its result must
 * never be written back** — see the header.
 *
 * A whole-file failure is a different thing from a dropped entry, and `dogear status` treats
 * it as one: there is nothing left to show, so it says so and exits non-zero.
 */
export function tryReadRegistry(path: string): RegistryRead {
  let registry: Registry
  try {
    registry = readRegistry(path)
  } catch (error) {
    return { ok: false, reason: messageOf(error) }
  }

  const projects: Record<string, Project> = {}
  for (const [key, value] of Object.entries(registry.projects)) {
    const project = asProject(value)
    if (project !== undefined) projects[key] = project
  }

  return { ok: true, registry: { ...registry, projects } }
}

/**
 * Record that a repository exists — `dogear init`'s half of an entry (E5, #30).
 *
 * A no-op when the entry is already there, which is what makes the init step idempotent
 * without a separate predicate to drift from this one. It never touches `servers`: init has
 * nothing to say about them, and a re-run must not clear the live dev servers of the repo it
 * is being run in.
 */
export function registerProject(path: string, root: string, now = new Date()): void {
  // Re-read HERE, immediately before the write, and never earlier. See the header.
  const current = readRegistry(path)
  const key = registryKey(root)
  const existing = current.projects[key]

  if (existing !== undefined && existing.initialisedAt !== undefined) return

  const project: Project = {
    root: existing?.root ?? root,
    initialisedAt: now.toISOString(),
    servers: existing?.servers ?? [],
  }

  writeRegistry(path, { ...current.projects, [key]: project }, now)
}

/**
 * Record a listening dev server — the plugin's half of an entry (E5, #30).
 *
 * Creates the entry when init never ran, so a hand-wired repository is still visible.
 *
 * **Dead records are dropped here, and this is the only place they are dropped.** The
 * alternative was `dogear status` pruning as it reads, which would make a read-sounding
 * command a writer and give it this file's concurrency obligations. A repository whose dev
 * servers all died keeps its stale records until it next runs one; `dogear status` filters
 * them out of the display with the same {@link isProcessAlive} check, so they are never
 * shown, only stored.
 *
 * **Our own pid is dropped before ours is added**, which is not defensive: Vite restarts its
 * dev server in-process when `vite.config` changes, so `configureServer` runs again under the
 * same pid and a plain append would accumulate a record per restart.
 */
export function registerServer(
  path: string,
  root: string,
  server: ServerInput,
  now = new Date(),
): void {
  // Re-read HERE, immediately before the write, and never earlier. See the header.
  const current = readRegistry(path)
  const key = registryKey(root)
  const existing = current.projects[key]

  const kept = (existing?.servers ?? []).filter(
    (record) => record.pid !== server.pid && isProcessAlive(record.pid),
  )

  const project: Project = {
    root: existing?.root ?? root,
    initialisedAt: existing?.initialisedAt,
    servers: [...kept, { ...server, startedAt: now.toISOString() }],
  }

  writeRegistry(path, { ...current.projects, [key]: project }, now)
}

/**
 * Remove a dev server's record — the plugin's best effort on a clean shutdown.
 *
 * Best effort is the whole contract. A dev server that is SIGKILLed, or whose machine loses
 * power, never reaches this, which is why {@link isProcessAlive} exists rather than this
 * being relied upon. Writes nothing when there is nothing to remove, so a second close event
 * costs no IO.
 */
export function deregisterServer(
  path: string,
  root: string,
  pid: number,
  now = new Date(),
): void {
  // Re-read HERE, immediately before the write, and never earlier. See the header.
  const current = readRegistry(path)
  const key = registryKey(root)
  const existing = current.projects[key]
  if (existing === undefined) return

  const servers = existing.servers.filter((record) => record.pid !== pid)
  if (servers.length === existing.servers.length) return

  writeRegistry(path, { ...current.projects, [key]: { ...existing, servers } }, now)
}

/**
 * Forget a repository entirely — `dogear init --undo`'s half of E6 (#39).
 *
 * The counterpart of {@link registerProject}, and it removes the **whole entry** rather than
 * clearing `initialisedAt`. An undone repository is not a half-registered one: `dogear status`
 * has no notion of a de-initialised repo, so leaving the entry behind would keep it in the list
 * forever with nothing to explain why. If the plugin is still installed, the next dev server to
 * start re-creates the entry through {@link registerServer} — which is correct, and is the same
 * reason a hand-wired repository shows up there without ever having been init'd.
 *
 * Writes nothing when there is nothing to remove, exactly as {@link deregisterServer} does, so
 * an undo on a repository that was never registered costs no IO and reports no change.
 */
export function deregisterProject(path: string, root: string, now = new Date()): void {
  // Re-read HERE, immediately before the write, and never earlier. See the header.
  const current = readRegistry(path)
  const key = registryKey(root)
  if (current.projects[key] === undefined) return

  // Rebuilt without the key rather than `delete`d from the object we were handed: `projects` is
  // typed readonly and the strict reader's result is shared with nothing, but a mutation here
  // would be the one place in this file that edits state in place.
  const projects = Object.fromEntries(
    Object.entries(current.projects).filter(([existing]) => existing !== key),
  )

  writeRegistry(path, projects, now)
}

/**
 * Does this process still exist?
 *
 * Signal 0 performs the permission and existence checks without delivering anything, which
 * makes this the cheapest true answer available and — unlike an HTTP probe of the origin —
 * involves no network at all. That matters beyond speed: dogear's zero-egress rule is
 * absolute, and a liveness check that opened a socket would need an exception written for it.
 *
 * **`EPERM` means alive.** The process exists but belongs to another user, so the signal was
 * refused rather than the target being absent. Reading that as dead would hide a dev server
 * started by a different account on a shared machine.
 *
 * Two honest limits: pids are reused, so a long-dead server can read as running if the number
 * came round again; and a process alive with its Vite server closed reads as running. Both are
 * healed the next time that repository starts a dev server.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The atomic write. Private on purpose — see the header.
 */
function writeRegistry(
  path: string,
  projects: Readonly<Record<string, Project>>,
  now: Date,
): void {
  mkdirSync(dirname(path), { recursive: true })

  const next = {
    version: REGISTRY_VERSION,
    updatedAt: now.toISOString(),
    projects,
  }

  const tempPath = tempPathFor(path)
  try {
    // Trailing newline for the same reason the queue has one: this file is meant to be
    // readable with `cat` when something looks wrong.
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tempPath, path)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

/** One entry, if it is shaped like one. Used only by the tolerant reader. */
function asProject(value: unknown): Project | undefined {
  if (!isObject(value)) return undefined

  const project = value as {
    root?: unknown
    initialisedAt?: unknown
    servers?: unknown
  }

  if (typeof project.root !== 'string' || project.root === '') return undefined

  // A missing or broken `servers` costs the servers, not the entry: knowing the repository is
  // registered is most of what `dogear status` has to say about it.
  const servers = Array.isArray(project.servers)
    ? project.servers.filter(isServerRecord)
    : []

  return {
    root: project.root,
    initialisedAt:
      typeof project.initialisedAt === 'string' ? project.initialisedAt : undefined,
    servers,
  }
}

function isServerRecord(value: unknown): value is ServerRecord {
  if (!isObject(value)) return false

  const record = value as { origin?: unknown; pid?: unknown; startedAt?: unknown }

  return (
    typeof record.origin === 'string' &&
    record.origin !== '' &&
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startedAt === 'string'
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
