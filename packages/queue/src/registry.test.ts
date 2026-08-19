import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  REGISTRY_VERSION,
  deregisterServer,
  isProcessAlive,
  readRegistry,
  registerProject,
  registerServer,
  registryHome,
  registryKey,
  registryPath,
  shortenHome,
  tryReadRegistry,
} from './registry.js'

/**
 * E5 (#30). The registry's guards, in the shape ./queue.test.ts established.
 *
 * The two that would fail silently rather than loudly, and are therefore the point of the
 * file: `registryKey` collapsing a drive letter's case — without which one repository gets
 * two entries on Windows and `dogear status` lists it twice — and every writer re-reading
 * immediately before writing, without which a second dev server's registration is erased.
 */

let home: string
let path: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dogear-registry-'))
  path = join(home, 'projects.json')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Write the file directly, standing in for another process. */
function writeBehindItsBack(projects: unknown, version = REGISTRY_VERSION): void {
  writeFileSync(
    path,
    JSON.stringify({ version, updatedAt: new Date().toISOString(), projects }),
  )
}

function read(): ReturnType<typeof readRegistry> {
  return readRegistry(path)
}

describe('registryHome / registryPath', () => {
  it('falls back to ~/.dogear when DOGEAR_HOME is unset', () => {
    expect(registryHome({})).toBe(join(homedir(), '.dogear'))
    expect(registryPath({})).toBe(join(homedir(), '.dogear', 'projects.json'))
  })

  // Literals, not `home`: an `it.each` table is built at collection time, before `beforeEach`
  // has assigned anything.
  it.each([
    ['an absolute path', resolve('/dogear-test-home')],
    ['a path needing resolution', '.'],
  ])('honours DOGEAR_HOME given %s', (_label, override) => {
    // Resolved, so the plugin (started by npm, from the package directory) and the CLI
    // (wherever the user is standing) cannot disagree about what a relative override means.
    expect(registryHome({ DOGEAR_HOME: override })).toBe(resolve(override))
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats a %s DOGEAR_HOME as unset', (_label, override) => {
    expect(registryHome({ DOGEAR_HOME: override })).toBe(join(homedir(), '.dogear'))
  })
})

describe('registryKey', () => {
  it('upper-cases a drive letter, so one repo cannot become two entries', () => {
    // The failure this whole function exists for: `dogear init` from a shell and a Vite
    // server spawned by npm report the same repository with different drive-letter case.
    expect(registryKey('c:/Code Projects/dogear')).toBe(
      registryKey('C:/Code Projects/dogear'),
    )
  })

  it('agrees across separators', () => {
    expect(registryKey('c:\\Code Projects\\dogear')).toBe(
      registryKey('c:/Code Projects/dogear'),
    )
  })

  it('produces forward slashes', () => {
    expect(registryKey(home)).not.toContain('\\')
  })

  it('leaves the rest of the path case alone', () => {
    // Directory names are the user's and are displayed back. Lower-casing the whole path
    // would make `dogear status` misspell them.
    expect(registryKey('c:/Code Projects/DoGeAr')).toContain('DoGeAr')
  })

  it('distinguishes genuinely different repositories', () => {
    expect(registryKey(join(home, 'a'))).not.toBe(registryKey(join(home, 'b')))
  })
})

describe('shortenHome', () => {
  it('collapses the home directory to ~', () => {
    expect(shortenHome(join(homedir(), '.dogear', 'projects.json'))).toBe(
      '~/.dogear/projects.json',
    )
  })

  it('leaves a path outside the home directory alone', () => {
    // Deliberately not a temp path: on Windows `tmpdir()` is `<home>/AppData/Local/Temp`,
    // so every temp directory in this file genuinely *is* under the home directory.
    const outside = resolve('/dogear-test-elsewhere/projects.json')
    expect(shortenHome(outside)).toBe(outside)
  })

  it('does not shorten a sibling directory that merely shares the prefix', () => {
    // `<home>-backup` starts with `<home>` as a string but is not inside it.
    const sibling = `${homedir()}-backup${sep}projects.json`
    expect(shortenHome(sibling)).toBe(sibling)
  })
})

describe('readRegistry', () => {
  it('treats a missing file as an empty registry', () => {
    expect(read()).toEqual({
      version: REGISTRY_VERSION,
      updatedAt: null,
      projects: {},
    })
  })

  it.each([
    ['invalid JSON', () => writeFileSync(path, '{ nope')],
    ['an array', () => writeFileSync(path, '[]')],
    ['no projects object', () => writeFileSync(path, '{"version":1}')],
    ['a projects array', () => writeBehindItsBack([])],
    ['a future schema version', () => writeBehindItsBack({}, 99)],
  ])('throws on %s', (_label, corrupt) => {
    corrupt()
    expect(() => read()).toThrow()
  })

  it('names the path in the message, so a reason is actionable', () => {
    writeFileSync(path, '{ nope')
    expect(() => read()).toThrow(path)
  })
})

describe('tryReadRegistry', () => {
  it('degrades a whole-file failure to a reason', () => {
    writeFileSync(path, '{ nope')

    const result = tryReadRegistry(path)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(path)
  })

  it('drops entries that are not project-shaped, keeping the rest', () => {
    writeBehindItsBack({
      good: { root: 'c:/a', servers: [] },
      'no-root': { servers: [] },
      'root-not-a-string': { root: 7, servers: [] },
      'not-an-object': 'nope',
    })

    const result = tryReadRegistry(path)
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.registry.projects)).toEqual(['good'])
  })

  it('drops a broken server record without dropping its project', () => {
    // Knowing the repository is registered is most of what status has to say about it.
    writeBehindItsBack({
      one: {
        root: 'c:/a',
        servers: [
          { origin: 'http://localhost:5173', pid: 1, startedAt: 'now' },
          { origin: '', pid: 2, startedAt: 'now' },
          { pid: 3, startedAt: 'now' },
          { origin: 'http://localhost:5175', pid: 0, startedAt: 'now' },
          'nope',
        ],
      },
      two: { root: 'c:/b', servers: 'not an array' },
    })

    const result = tryReadRegistry(path)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.registry.projects.one?.servers.map((s) => s.pid)).toEqual([1])
    expect(result.registry.projects.two?.servers).toEqual([])
  })
})

describe('registerProject', () => {
  it('creates an entry keyed by registryKey', () => {
    registerProject(path, 'c:/Code Projects/dogear')

    expect(Object.keys(read().projects)).toEqual([registryKey('c:/Code Projects/dogear')])
  })

  it('preserves the creator’s own spelling of the root for display', () => {
    registerProject(path, 'c:/Code Projects/dogear')

    expect(read().projects[registryKey('c:/Code Projects/dogear')]?.root).toBe(
      'c:/Code Projects/dogear',
    )
  })

  it('is a no-op on a second run, which is what makes the init step idempotent', () => {
    registerProject(path, home, new Date('2020-01-01T00:00:00.000Z'))
    registerProject(path, home, new Date('2021-01-01T00:00:00.000Z'))

    expect(read().projects[registryKey(home)]?.initialisedAt).toBe(
      '2020-01-01T00:00:00.000Z',
    )
  })

  it('does not clear the servers of a repo the plugin registered first', () => {
    // A re-run of `dogear init` in a repo with a dev server up must not blank it.
    registerServer(path, home, { origin: 'http://localhost:5173', pid: process.pid })
    registerProject(path, home)

    const project = read().projects[registryKey(home)]
    expect(project?.servers).toHaveLength(1)
    expect(project?.initialisedAt).toBeDefined()
  })

  it('re-reads before writing, so another repo registered meanwhile survives', () => {
    registerProject(path, join(home, 'a'))
    // Another process registers between our read and our write.
    registerProject(path, join(home, 'b'))

    expect(Object.keys(read().projects)).toHaveLength(2)
  })

  it('refuses to write over a file it cannot parse', () => {
    // Writes must refuse. Overwriting would destroy whatever the user still had in there.
    writeFileSync(path, '{ nope')
    expect(() => registerProject(path, home)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{ nope')
  })
})

describe('registerServer', () => {
  it('creates the entry when init never ran, with no initialisedAt', () => {
    registerServer(path, home, { origin: 'http://localhost:5173', pid: process.pid })

    const project = read().projects[registryKey(home)]
    expect(project?.initialisedAt).toBeUndefined()
    expect(project?.servers).toHaveLength(1)
  })

  it('stamps startedAt and keeps origin, pid and app', () => {
    registerServer(
      path,
      home,
      { origin: 'http://localhost:5173', pid: process.pid, app: 'react-app' },
      new Date('2020-01-01T00:00:00.000Z'),
    )

    expect(read().projects[registryKey(home)]?.servers[0]).toEqual({
      origin: 'http://localhost:5173',
      pid: process.pid,
      app: 'react-app',
      startedAt: '2020-01-01T00:00:00.000Z',
    })
  })

  it('preserves initialisedAt written by init', () => {
    registerProject(path, home, new Date('2020-01-01T00:00:00.000Z'))
    registerServer(path, home, { origin: 'http://localhost:5173', pid: process.pid })

    expect(read().projects[registryKey(home)]?.initialisedAt).toBe(
      '2020-01-01T00:00:00.000Z',
    )
  })

  it('replaces its own record rather than appending, for an in-process Vite restart', () => {
    registerServer(path, home, { origin: 'http://localhost:5173', pid: process.pid })
    registerServer(path, home, { origin: 'http://localhost:5174', pid: process.pid })

    const servers = read().projects[registryKey(home)]?.servers
    expect(servers).toHaveLength(1)
    expect(servers?.[0]?.origin).toBe('http://localhost:5174')
  })

  it('drops records whose process is gone, and keeps ones that are alive', () => {
    // A pid that cannot be running: nothing else in this file has to know which.
    writeBehindItsBack({
      [registryKey(home)]: {
        root: home,
        servers: [
          { origin: 'http://localhost:9999', pid: 2 ** 30, startedAt: 'then' },
          { origin: 'http://localhost:5173', pid: process.pid, startedAt: 'then' },
        ],
      },
    })

    registerServer(path, home, { origin: 'http://localhost:5174', pid: process.ppid })

    const pids = read().projects[registryKey(home)]?.servers.map((s) => s.pid)
    expect(pids).not.toContain(2 ** 30)
    expect(pids).toContain(process.ppid)
  })

  it('keeps other repositories untouched', () => {
    registerProject(path, join(home, 'other'))
    registerServer(path, home, { origin: 'http://localhost:5173', pid: process.pid })

    expect(Object.keys(read().projects)).toHaveLength(2)
  })

  it('writes atomically through a pid-suffixed temp file, leaving none behind', () => {
    registerServer(path, home, { origin: 'http://localhost:5173', pid: process.pid })

    expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('deregisterServer', () => {
  it('removes only the named pid', () => {
    writeBehindItsBack({
      [registryKey(home)]: {
        root: home,
        servers: [
          { origin: 'http://localhost:5173', pid: process.pid, startedAt: 'then' },
          { origin: 'http://localhost:5174', pid: process.ppid, startedAt: 'then' },
        ],
      },
    })

    deregisterServer(path, home, process.pid)

    expect(read().projects[registryKey(home)]?.servers.map((s) => s.pid)).toEqual([
      process.ppid,
    ])
  })

  it('writes nothing when there is nothing to remove', () => {
    registerProject(path, home, new Date('2020-01-01T00:00:00.000Z'))
    const before = readFileSync(path, 'utf8')

    deregisterServer(path, home, 2 ** 30)
    deregisterServer(path, join(home, 'never-registered'), process.pid)

    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('isProcessAlive', () => {
  it('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('is false for a %s pid rather than throwing', (_label, pid) => {
    // `process.kill` throws ESRCH/EINVAL on these; a liveness check must answer, not explode.
    expect(isProcessAlive(pid)).toBe(false)
  })
})
