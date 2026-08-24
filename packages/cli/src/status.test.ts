import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RegistryEnv } from 'dogear-queue'
import {
  QUEUE_DIR,
  queuePathFor,
  registerProject,
  registerServer,
  registryPath,
  shortenHome,
  writeQueue,
} from 'dogear-queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RepoStatus } from './status.js'
import { formatStatus, status } from './status.js'
import { createRepo, isolateGitConfig, removeRepo } from './test-repo.js'

/**
 * `dogear status` — E5 (#30).
 *
 * Split the way ./scaffold.ts's suite is: `formatStatus` is a pure function over what was
 * found, so every byte it produces is asserted without a filesystem, and the `status()` cases
 * below cover only the reading and the two exit codes.
 *
 * **The acceptance criterion that cannot be shown here is "works from anywhere".** Proving it
 * needs a process whose working directory is outside any repository, which is
 * ../test-built/status.test.ts's job. What this file pins is the half that criterion rests on:
 * a `cwd` in no repository is an ordinary input, not a refusal.
 */

let home: string
let env: RegistryEnv
let path: string
let restoreGitConfig: () => void

beforeEach(() => {
  restoreGitConfig = isolateGitConfig()
  home = mkdtempSync(join(tmpdir(), 'dogear-status-home-'))
  env = { DOGEAR_HOME: home }
  path = registryPath(env)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  restoreGitConfig()
})

/** A repo line with everything at its quietest, for the formatter table to vary one field. */
function repo(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    root: 'c:/repo',
    current: false,
    missing: false,
    pending: 0,
    servers: [],
    ...overrides,
  }
}

const SERVER = {
  origin: 'http://localhost:5173',
  pid: 41288,
  app: 'react-app',
  startedAt: '2026-08-19T00:00:00.000Z',
}

describe('formatStatus', () => {
  it('says so when nothing is registered, and names the file', () => {
    const output = formatStatus([], '~/.dogear/projects.json')

    expect(output).toContain('no repositories registered')
    expect(output).toContain('dogear init')
    expect(output).toContain('~/.dogear/projects.json')
  })

  it('counts repositories and running servers in the header', () => {
    const output = formatStatus(
      [repo({ servers: [SERVER] }), repo({ root: 'c:/other' })],
      'x',
    )

    expect(output.split('\n')[0]).toBe(
      'dogear: 2 repositories registered, 1 dev server running',
    )
  })

  // Singular and plural are the sort of thing that only ever reads wrong in the case nobody
  // built a fixture for. The zero-repository case is not here because it never reaches the
  // header at all — it has its own sentence, asserted above.
  it.each([
    [1, 0, '1 repository registered, 0 dev servers running'],
    [1, 1, '1 repository registered, 1 dev server running'],
    [2, 3, '2 repositories registered, 3 dev servers running'],
  ])('pluralises %i repos and %i servers', (repos, servers, expected) => {
    const lines = Array.from({ length: repos }, (_, i) =>
      repo({
        root: `c:/r${i}`,
        servers: i === 0 ? Array.from({ length: servers }, () => SERVER) : [],
      }),
    )

    expect(formatStatus(lines, 'x')).toContain(expected)
  })

  it('nests each server under its repository with origin, pid and app', () => {
    const output = formatStatus([repo({ servers: [SERVER] })], 'x')

    expect(output).toContain('    http://localhost:5173  pid 41288  react-app')
  })

  it('omits the app when the plugin resolved none', () => {
    const output = formatStatus([repo({ servers: [{ ...SERVER, app: undefined }] })], 'x')

    expect(output).toContain('    http://localhost:5173  pid 41288')
    expect(output).not.toContain('undefined')
  })

  it('says a repository has no dev server rather than leaving it blank', () => {
    expect(formatStatus([repo()], 'x')).toContain('no dev server running')
  })

  it('marks the repository the command was run in', () => {
    const output = formatStatus(
      [repo({ current: true }), repo({ root: 'c:/other' })],
      'x',
    )

    expect(output).toContain('(this repo)')
    expect(output.match(/\(this repo\)/g)).toHaveLength(1)
  })

  it('aligns the right-hand column across roots of different lengths', () => {
    const output = formatStatus(
      [repo({ root: 'c:/a' }), repo({ root: 'c:/a-much-longer-path' })],
      'x',
    )
    const columns = output
      .split('\n')
      .filter((line) => line.includes('pending'))
      .map((line) => line.indexOf('0 pending'))

    expect(new Set(columns).size).toBe(1)
  })

  it('does not let one very long root widen every other row', () => {
    // Found by running the command against a deeply nested checkout: padding everything to the
    // longest root wraps the whole list in an 80-column terminal.
    const long = `c:/${'nested/'.repeat(20)}repo`
    const output = formatStatus([repo({ root: 'c:/a' }), repo({ root: long })], 'x')

    const shortLine = output.split('\n').find((line) => line.includes('c:/a'))
    expect(shortLine?.length).toBeLessThan(80)
    // The outlier still appears in full — it is truncated nowhere, only left unaligned.
    expect(output).toContain(long)
  })

  it.each([
    ['queue unreadable', repo({ pending: undefined })],
    ['directory missing', repo({ missing: true })],
    ['3 pending', repo({ pending: 3 })],
  ])('reports %s in the right-hand column', (expected, line) => {
    expect(formatStatus([line], 'x')).toContain(expected)
  })

  it('tells the user what to do about a missing directory', () => {
    // The one state status cannot resolve on its own — it does not know whether the repo moved
    // or is gone, and it never writes, so the choice has to be handed back.
    const output = formatStatus([repo({ missing: true })], 'x')

    expect(output).toContain('dogear init')
    expect(output).toContain('remove the entry')
  })
})

describe('status()', () => {
  it('exits 0 and says so when no repository has been registered', () => {
    const result = status(env, tmpdir())

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('no repositories registered')
  })

  it('exits non-zero on a registry that will not parse', () => {
    // Unlike one corrupt queue among many, this leaves nothing to show. A human typed the
    // command and deserves a non-zero exit, exactly as `dogear prune` gives them.
    mkdirSync(home, { recursive: true })
    writeFileSync(path, '{ nope')

    const result = status(env, tmpdir())

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('could not be read')
    expect(result.output).toContain(shortenHome(path))
  })

  it('lists a registered repository and its pending count', () => {
    const root = createRepo('dogear-status-')
    try {
      registerProject(path, root)
      mkdirSync(join(root, QUEUE_DIR), { recursive: true })
      writeQueue(queuePathFor(root), [
        { id: 'a', status: 'pending', comment: 'one' },
        { id: 'b', status: 'resolved', comment: 'two' },
      ])

      const result = status(env, tmpdir())

      expect(result.exitCode).toBe(0)
      expect(result.output).toContain(root)
      // Resolved items are not pending — the count is what reaches an agent, not the file size.
      expect(result.output).toContain('1 pending')
    } finally {
      removeRepo(root)
    }
  })

  it('reports a repository whose directory is gone, and changes nothing', () => {
    const root = createRepo('dogear-status-gone-')
    registerProject(path, root)
    removeRepo(root)

    const before = registrySnapshot()
    const result = status(env, tmpdir())

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('directory missing')
    // Never a writer: the entry survives for the user to decide about.
    expect(registrySnapshot()).toBe(before)
  })

  it('shows a dead dev server as not running, without deleting its record', () => {
    const root = createRepo('dogear-status-dead-')
    try {
      // A pid that cannot be alive. Dropping it is the plugin's job, on this repo's next start.
      registerServer(path, root, { origin: 'http://localhost:5173', pid: 2 ** 30 })

      const result = status(env, tmpdir())

      expect(result.output).toContain('no dev server running')
      expect(result.output).toContain('0 dev servers running')
      expect(registrySnapshot()).toContain('1073741824')
    } finally {
      removeRepo(root)
    }
  })

  it('shows a live dev server as running', () => {
    const root = createRepo('dogear-status-live-')
    try {
      registerServer(path, root, {
        origin: 'http://localhost:5173',
        pid: process.pid,
        app: 'react-app',
      })

      const result = status(env, tmpdir())

      expect(result.output).toContain('1 dev server running')
      expect(result.output).toContain('http://localhost:5173')
      expect(result.output).toContain('react-app')
    } finally {
      removeRepo(root)
    }
  })

  it('does not refuse outside a git repository — the criterion no other command meets', () => {
    const root = createRepo('dogear-status-anywhere-')
    try {
      registerProject(path, root)
      // `tmpdir()` is not a repository, and on Windows it is not below one either.
      const result = status(env, tmpdir())

      expect(result.exitCode).toBe(0)
      expect(result.output).toContain(root)
      expect(result.output).not.toContain('(this repo)')
    } finally {
      removeRepo(root)
    }
  })

  it('marks the current repository when run inside one', () => {
    const root = createRepo('dogear-status-here-')
    try {
      registerProject(path, root)

      expect(status(env, root).output).toContain('(this repo)')
    } finally {
      removeRepo(root)
    }
  })

  it('marks the current repository from a subdirectory of it', () => {
    const root = createRepo('dogear-status-nested-')
    try {
      registerProject(path, root)
      const nested = join(root, 'packages', 'app')
      mkdirSync(nested, { recursive: true })

      // Walks up for `.git`, like every other command — a monorepo user is rarely at the root.
      expect(status(env, nested).output).toContain('(this repo)')
    } finally {
      removeRepo(root)
    }
  })

  it('keeps one repository’s broken queue from hiding the others', () => {
    const good = createRepo('dogear-status-good-')
    const bad = createRepo('dogear-status-bad-')
    try {
      registerProject(path, good)
      registerProject(path, bad)
      mkdirSync(join(bad, QUEUE_DIR), { recursive: true })
      writeFileSync(queuePathFor(bad), '{ nope')

      const result = status(env, tmpdir())

      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('queue unreadable')
      expect(result.output).toContain(good)
      expect(result.output).toContain(bad)
    } finally {
      removeRepo(good)
      removeRepo(bad)
    }
  })

  it('orders repositories stably, whatever order they were registered in', () => {
    const a = createRepo('dogear-status-aaa-')
    const b = createRepo('dogear-status-bbb-')
    try {
      registerProject(path, b)
      registerProject(path, a)

      const first = status(env, tmpdir()).output
      registerProject(path, b)

      expect(status(env, tmpdir()).output).toBe(first)
    } finally {
      removeRepo(a)
      removeRepo(b)
    }
  })
})

/** The registry's bytes, for the assertions that nothing was written. */
function registrySnapshot(): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
