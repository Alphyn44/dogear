import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RegistryEnv } from '@dogear/queue'
import {
  readRegistry,
  registerServer,
  registryKey,
  registryPath,
  shortenHome,
} from '@dogear/queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDeregisterStep, createRegisterStep } from './register.js'
import { NO_DETECTION } from './test-repo.js'

/**
 * `dogear init`'s registry step — E5 (#30).
 *
 * No git repository is needed: this step never looks at the root beyond using it as a key, so
 * a plain temp directory stands in. ./scaffold.test.ts covers its place in the runner and its
 * line in the report; what is here is the step's own three answers — a change, `undefined`,
 * and a note — and the rule that makes the middle one work.
 */

let home: string
let root: string
let env: RegistryEnv
let path: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dogear-register-home-'))
  root = mkdtempSync(join(tmpdir(), 'dogear-register-root-'))
  env = { DOGEAR_HOME: home }
  path = registryPath(env)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

function plan() {
  return createRegisterStep(env).plan(root, NO_DETECTION)
}

describe('createRegisterStep', () => {
  it('plans a change for a repository that is not registered', () => {
    expect(plan()?.change?.summary).toBe(
      `registered this repository in ${shortenHome(path)}`,
    )
  })

  it('writes nothing at plan time — the rule --dry-run is built on', () => {
    plan()

    expect(readRegistry(path).projects).toEqual({})
  })

  it('registers the repository when applied', () => {
    plan()?.change?.apply()

    expect(readRegistry(path).projects[registryKey(root)]?.root).toBe(root)
  })

  it('returns undefined on a second run, so the report stays quiet', () => {
    // Idempotency is the absence of a code path: there is no `alreadyRegistered()` beside
    // this to drift from it.
    plan()?.change?.apply()

    expect(plan()).toBeUndefined()
  })

  it('still has work to do for a repo the plugin registered but init never did', () => {
    // The entry exists, but with no `initialisedAt` — which is why the check asks for that
    // field rather than for the key being present.
    registerServer(path, root, { origin: 'http://localhost:5173', pid: process.pid })

    expect(plan()?.change).toBeDefined()

    plan()?.change?.apply()
    const project = readRegistry(path).projects[registryKey(root)]
    expect(project?.initialisedAt).toBeDefined()
    // And applying must not have cost the dev server its record.
    expect(project?.servers).toHaveLength(1)
  })

  it('reports an unreadable registry as a note rather than throwing', () => {
    // `plan()` runs before any `apply()`, so throwing here would take out an init that has
    // nothing to do with the registry.
    writeFileSync(path, '{ nope')

    const result = plan()
    expect(result?.change).toBeUndefined()
    expect(result?.notes?.[0]).toContain('could not be read')
    expect(result?.notes?.[0]).toContain(shortenHome(path))
  })

  it('leaves an unreadable registry exactly as it found it', () => {
    // A note is not a change: this file may hold other repositories' entries, and overwriting
    // it to fix this one would lose them.
    writeFileSync(path, '{ nope')
    plan()

    expect(readFileSync(path, 'utf8')).toBe('{ nope')
  })

  it('creates the registry directory when it does not exist yet', () => {
    // The commonest case on a fresh machine: ~/.dogear has never been written to.
    rmSync(home, { recursive: true, force: true })

    plan()?.change?.apply()

    expect(readRegistry(path).projects[registryKey(root)]).toBeDefined()
  })

  it('keeps other repositories’ entries', () => {
    const other = join(tmpdir(), 'dogear-register-other')
    registerServer(path, other, { origin: 'http://localhost:5173', pid: process.pid })

    plan()?.change?.apply()

    expect(Object.keys(readRegistry(path).projects)).toHaveLength(2)
  })
})

describe('createDeregisterStep — E6 (#39)', () => {
  function undo() {
    return createDeregisterStep(env).plan(root)
  }

  it('plans nothing for a repository that was never registered', () => {
    expect(undo()).toBeUndefined()
  })

  it('removes the entry', () => {
    plan()?.change?.apply()

    expect(undo()?.change?.summary).toBe(
      `removed this repository from ${shortenHome(path)}`,
    )
    undo()?.change?.apply()

    expect(readRegistry(path).projects[registryKey(root)]).toBeUndefined()
  })

  it('writes nothing at plan time — the rule --dry-run is built on', () => {
    plan()?.change?.apply()

    undo()

    expect(readRegistry(path).projects[registryKey(root)]).toBeDefined()
  })

  it('keeps other repositories’ entries', () => {
    const other = join(tmpdir(), 'dogear-register-other')
    registerServer(path, other, { origin: 'http://localhost:5173', pid: process.pid })
    plan()?.change?.apply()

    undo()?.change?.apply()

    expect(readRegistry(path).projects[registryKey(other)]).toBeDefined()
    expect(readRegistry(path).projects[registryKey(root)]).toBeUndefined()
  })

  it('removes an entry the plugin created without init ever running', () => {
    // Deleting the whole entry rather than clearing `initialisedAt`: `dogear status` has no
    // notion of a de-initialised repo, so a half-cleared entry would sit in the list forever.
    registerServer(path, root, { origin: 'http://localhost:5173', pid: process.pid })

    undo()?.change?.apply()

    expect(readRegistry(path).projects[registryKey(root)]).toBeUndefined()
  })

  it('warns that a live dev server is still serving the overlay', () => {
    // Undo removes configuration, not the installed plugin. A dev server already up still has
    // @dogear/vite loaded and will recreate the queue on the next click.
    registerServer(path, root, { origin: 'http://localhost:5173', pid: process.pid })

    const note = undo()?.notes?.[0]

    expect(note).toContain('http://localhost:5173')
    expect(note).toContain(`pid ${process.pid}`)
    expect(note).toContain('until you restart it')
  })

  it('says nothing about a dev server whose process has gone', () => {
    // The pid probe, not the record's presence — a dead server is not something to act on.
    registerServer(path, root, { origin: 'http://localhost:5173', pid: 0x7fffffff })

    expect(undo()?.notes).toBeUndefined()
  })

  it('notes a registry it cannot read rather than throwing', () => {
    writeFileSync(path, 'not json')

    expect(() => undo()).not.toThrow()
    expect(undo()?.notes?.[0]).toContain('could not be read')
    expect(undo()?.change).toBeUndefined()
  })
})
