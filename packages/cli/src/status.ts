import { existsSync } from 'node:fs'

import type { Project, RegistryEnv, ServerRecord } from 'dogear-queue'
import {
  findGitRoot,
  isProcessAlive,
  pendingOnly,
  queuePathFor,
  registryKey,
  registryPath,
  shortenHome,
  tryReadQueue,
  tryReadRegistry,
} from 'dogear-queue'

import type { Result } from './run.js'

/**
 * `dogear status` — what is running and what is pending, across every registered repo (E5, #30).
 *
 * **The first command that does not refuse outside a git repository.** `init`, `prune`, `hook`
 * and `mcp` all open by walking up for `.git` and giving up if there isn't one, because each
 * of them acts on *a* repository. This one acts on the machine, which is the whole point of
 * `~/.dogear/projects.json` existing: the answer to "which of my dev servers is up" is not
 * something the directory you happen to be standing in can narrow down. `findGitRoot` is still
 * called, but only to mark the current repo in the list — `undefined` is an ordinary answer.
 *
 * **Nothing here writes, and that is a design rule rather than an accident.** A dead server
 * record is dropped by the *plugin* when that repo next starts one; this command filters dead
 * pids out of the display and leaves the file alone. Making a read-sounding command a writer
 * would hand it the registry's read-modify-write obligations for no gain, and a `dogear
 * status` that mutated machine state on every run is a surprise nobody asked for.
 *
 * **Two failure scales, deliberately handled differently.** A registry that will not parse is
 * fatal: there is nothing left to show, so it reports and exits non-zero exactly as `prune`
 * does on a corrupt queue. A single repository's queue that will not parse, or whose directory
 * has been deleted, costs that repository's line and nothing else — one broken repo must not
 * hide the other nine. That is `dogear-queue`'s "reads may tolerate" rule at the granularity
 * it was written for, and it is why `tryReadQueue` is used here, making this its third caller
 * after `dogear hook` and `dogear_pending`.
 *
 * **No MCP tool answers this, and that is a decision.** The brief's rule is that a capability
 * unreachable through MCP does not ship; the exception is argued in the Decisions log. In
 * short: the MCP server resolves its repository from `cwd`, so every agent session is scoped
 * to one repo, and `dogear_pending` already answers "what is pending here". Cross-repo state
 * is not a capability an agent is missing — it is one it has no business having.
 */
export function status(env: RegistryEnv, cwd: string): Result {
  const path = registryPath(env)
  const read = tryReadRegistry(path)

  if (!read.ok) {
    return {
      output: `dogear: ${shortenHome(path)} could not be read: ${read.reason}`,
      exitCode: 1,
    }
  }

  // `undefined` outside a repository, which is not a failure here — it only means no line
  // gets marked as the current one.
  const here = findGitRoot(cwd)
  const currentKey = here === undefined ? undefined : registryKey(here)

  // Sorted by key rather than left in insertion order, so the output is stable across runs
  // and across machines that registered the same repositories in a different sequence.
  const repos = Object.entries(read.registry.projects)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, project]) => inspect(key, project, currentKey))

  return { output: formatStatus(repos, shortenHome(path)), exitCode: 0 }
}

/** One repository, as `dogear status` found it. */
export interface RepoStatus {
  /** The root as its creator spelled it — what the user sees. */
  readonly root: string
  readonly current: boolean
  /** The directory is gone: moved, deleted, or on an unmounted drive. */
  readonly missing: boolean
  /** Pending annotations, or `undefined` when the queue could not be read. */
  readonly pending: number | undefined
  /** Live dev servers only. Dead records are filtered here, never deleted. */
  readonly servers: readonly ServerRecord[]
}

/**
 * Everything the display needs about one entry, without touching the registry again.
 *
 * The order matters in one place: a missing directory short-circuits the queue read, because
 * `tryReadQueue` on a path under a deleted root would report "could not be read" and the line
 * would say the queue is broken when the truth is that the repository is gone.
 */
function inspect(
  key: string,
  project: Project,
  currentKey: string | undefined,
): RepoStatus {
  const missing = !existsSync(project.root)
  const servers = project.servers.filter((record) => isProcessAlive(record.pid))

  return {
    root: project.root,
    current: key === currentKey,
    missing,
    pending: missing ? undefined : pendingCountFor(project.root),
    servers,
  }
}

function pendingCountFor(root: string): number | undefined {
  const read = tryReadQueue(queuePathFor(root))

  return read.ok ? pendingOnly(read.items).length : undefined
}

/**
 * The report — a pure function over what was found, so every byte is assertable without a
 * filesystem. The same split ./scaffold.ts uses, and for the same reason.
 *
 * **Grouped by repository with servers nested**, rather than one row per repo. A monorepo runs
 * three dev servers against one queue, and a flat table has to collapse them to a count —
 * losing the origins, which are the part you would actually click.
 */
export function formatStatus(
  repos: readonly RepoStatus[],
  registryLabel: string,
): string {
  if (repos.length === 0) {
    return [
      'dogear: no repositories registered yet.',
      `  Run \`dogear init\` in a repository to add one. The registry lives at ${registryLabel}.`,
    ].join('\n')
  }

  const running = repos.reduce((total, repo) => total + repo.servers.length, 0)

  // Padded so the states line up, which is what makes the list scannable at a glance. Measured
  // from the roots actually present rather than a fixed width, because these are absolute paths
  // and any constant would be wrong on somebody's machine.
  //
  // **Capped, because one outlier must not widen every other row.** Repository paths have no
  // upper bound — a checkout under a deeply nested directory is ordinary — and padding all of
  // them to the longest turns a tidy column into a wrapped mess in any normal terminal. Past
  // the cap a row simply runs long and its state follows two spaces later: that one line loses
  // its alignment, and every other line keeps it. Found by running the command rather than by
  // a test, which is why ./status.test.ts now pins it.
  const width = Math.min(Math.max(...repos.map((repo) => repo.root.length)), ROOT_COLUMN)

  const body = repos.flatMap((repo) => [
    '',
    `  ${repo.root.padEnd(width)}  ${state(repo)}${repo.current ? '  (this repo)' : ''}`,
    ...serverLines(repo),
  ])

  return [
    `dogear: ${count(repos.length, 'repository', 'repositories')} registered, ` +
      `${count(running, 'dev server', 'dev servers')} running`,
    ...body,
  ].join('\n')
}

/**
 * How wide the root column is allowed to get before a row is left to run long.
 *
 * Chosen against an 80-column terminal: the widest state is `directory missing` at 17
 * characters, plus the two-space indent and the two-space gap, which leaves a root this wide
 * ending a line at 79.
 */
const ROOT_COLUMN = 58

/** The right-hand column: what is worth knowing about this repo in three words. */
function state(repo: RepoStatus): string {
  if (repo.missing) return 'directory missing'
  if (repo.pending === undefined) return 'queue unreadable'

  return `${repo.pending} pending`
}

function serverLines(repo: RepoStatus): readonly string[] {
  if (repo.missing) {
    // Actionable rather than merely descriptive: this is the one state the user has to
    // resolve by hand, and `dogear status` cannot know which of the two they meant.
    return [
      '    re-run `dogear init` there, or remove the entry, if it has moved for good',
    ]
  }

  if (repo.servers.length === 0) return ['    no dev server running']

  return repo.servers.map((record) => {
    const app = record.app === undefined || record.app === '' ? '' : `  ${record.app}`

    return `    ${record.origin}  pid ${record.pid}${app}`
  })
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}
