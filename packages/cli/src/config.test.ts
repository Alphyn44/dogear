import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QUEUE_DIR, configPathFor } from '@dogear/queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { configFile } from './config.js'

/**
 * The `.dogear/config.json` step — E4 (#29).
 *
 * No git repository here: this step never asks git anything, and the plain temp directory
 * keeps the suite honest about that. ./gitignore.test.ts is where the real repositories are.
 *
 * **The idempotency cases carry the weight.** `config.json` is the one file in `.dogear/`
 * meant to be edited by hand and committed, so the failure that matters is not a missing
 * file — it is an init that quietly replaces a repository's settings on a re-run.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-config-'))
  mkdirSync(join(root, QUEUE_DIR))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function apply(): void {
  configFile.plan(root)?.change?.apply()
}

function read(): string {
  return readFileSync(configPathFor(root), 'utf8')
}

describe('the config step on a fresh repository', () => {
  it('writes version and nothing else', () => {
    // Not the brief's full default block. A config that restates a default pins it, so a
    // later release that changes one could never reach a repository that ran init.
    apply()

    expect(JSON.parse(read())).toEqual({ version: 1 })
  })

  it('writes it readably, with a trailing newline', () => {
    // `cat .dogear/config.json` is a stated design goal, the same one `writeQueue` serves.
    apply()

    expect(read()).toBe('{\n  "version": 1\n}\n')
  })

  it('reports the path it created', () => {
    expect(configFile.plan(root)?.change?.summary).toBe(
      `created ${QUEUE_DIR}/config.json`,
    )
  })

  it('reports no notes', () => {
    expect(configFile.plan(root)?.notes).toBeUndefined()
  })
})

describe('the config step on a repository that already has one', () => {
  it('has nothing to do', () => {
    apply()

    expect(configFile.plan(root)).toBeUndefined()
  })

  it('leaves a hand-edited config byte-identical', () => {
    const edited = '{\n  "version": 1,\n  "modifier": "ctrl"\n}\n'
    writeFileSync(configPathFor(root), edited)

    apply()

    expect(read()).toBe(edited)
  })

  it('leaves an unparseable config alone', () => {
    // "Reads may tolerate, writes must refuse" one level up. Rewriting a broken config
    // destroys the evidence of whatever broke it, and the error belongs to E7's reader,
    // which has a dev server and a developer to tell.
    writeFileSync(configPathFor(root), '{ not json')

    apply()

    expect(read()).toBe('{ not json')
  })

  it('leaves an empty config alone', () => {
    // Deliberately not treated as "absent". Zero bytes is a file someone may have created
    // on purpose, and guessing at intent is how init destroys work.
    writeFileSync(configPathFor(root), '')

    apply()

    expect(read()).toBe('')
  })
})

describe('the config step when the path is occupied by something else', () => {
  it('plans without throwing when .dogear is a regular file', () => {
    // The case ./scaffold.test.ts pins for the directory step. Every plan() runs before any
    // apply(), so this one stats `<file>/config.json` and gets ENOTDIR — which
    // `throwIfNoEntry: false` does not suppress, because that option covers ENOENT only.
    rmSync(join(root, QUEUE_DIR), { recursive: true })
    writeFileSync(join(root, QUEUE_DIR), 'not a directory')

    expect(() => configFile.plan(root)).not.toThrow()
  })

  it('fails on apply when config.json is a directory, naming the way out', () => {
    mkdirSync(configPathFor(root))

    const change = configFile.plan(root)?.change

    expect(() => change?.apply()).toThrow(/is not a regular file/)
    expect(() => change?.apply()).toThrow(/Remove it and re-run/)
  })
})
