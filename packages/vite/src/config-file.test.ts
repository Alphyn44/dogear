import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { FileConfig } from './config-file.js'
import { readConfigFile } from './config-file.js'

/**
 * E7 (#40) — reading `.dogear/config.json`.
 *
 * Driven against real files rather than a stubbed `fs`, because half of what this module has
 * to get right is what the filesystem does to it: ENOENT versus EISDIR, a BOM a Windows editor
 * wrote, bytes that are not JSON at all. A mock would be asserting the mock.
 *
 * Two assertions on almost every case, and the pairing is the point. Checking only the
 * returned config would pass for a module that silently swallowed everything; checking only
 * the warnings would pass for one that warned and then applied the bad value anyway.
 */

let gitRoot: string

beforeEach(() => {
  gitRoot = mkdtempSync(join(tmpdir(), 'dogear-config-'))
})

afterEach(() => {
  rmSync(gitRoot, { recursive: true, force: true })
})

/** Write `.dogear/config.json` verbatim — a string, so malformed bytes are expressible. */
function write(contents: string): void {
  mkdirSync(join(gitRoot, '.dogear'), { recursive: true })
  writeFileSync(join(gitRoot, '.dogear', 'config.json'), contents)
}

function read(): { config: FileConfig; warnings: string[] } {
  const warnings: string[] = []
  const config = readConfigFile(gitRoot, (message) => warnings.push(message))
  return { config, warnings }
}

/** Read a file written from an object — the ordinary, well-formed case. */
function readObject(value: unknown): { config: FileConfig; warnings: string[] } {
  write(JSON.stringify(value))
  return read()
}

describe('the quiet cases', () => {
  it('says nothing at all when there is no file', () => {
    // The commonest state in the world: a repo that never ran `dogear init`. A warning here
    // would fire on every dev server start for a file nobody asked for.
    const { config, warnings } = read()

    expect(config).toEqual({})
    expect(warnings).toEqual([])
  })

  it('says nothing for the file `dogear init` actually writes', () => {
    // E4 writes `{ "version": 1 }` and stops — see the brief's Decisions log. Every repo that
    // has ever run init is in this state, so it is the case that must not produce output, and
    // it must contribute no keys either or ./index.ts would log a confirmation line for it.
    const { config, warnings } = readObject({ version: 1 })

    expect(config).toEqual({})
    expect(warnings).toEqual([])
  })

  it('says nothing about recognised keys it does not layer', () => {
    // `app` is excluded on purpose (per Vite root, this file is per repo) and `agent` belongs
    // to `dogear init`. A file setting them is correct, and telling its author otherwise on
    // every start would be worse than saying nothing.
    const { config, warnings } = readObject({ version: 1, app: 'web', agent: 'claude' })

    expect(config).toEqual({})
    expect(warnings).toEqual([])
  })

  it('reads a file a Windows editor wrote with a BOM', () => {
    // `JSON.parse` throws on a leading U+FEFF, so without stripping it a perfectly valid
    // config is reported as unreadable. E4 hit this with `.claude/settings.json`.
    write(`﻿${JSON.stringify({ version: 1, modifier: 'ctrl' })}`)
    const { config, warnings } = read()

    expect(config).toEqual({ modifier: 'ctrl' })
    expect(warnings).toEqual([])
  })
})

describe('every layered key, when it is valid', () => {
  const cases: ReadonlyArray<readonly [string, unknown, FileConfig]> = [
    ['enabled', { enabled: false }, { enabled: false }],
    ['endpoint', { endpoint: '/__annotate' }, { endpoint: '/__annotate' }],
    ['modifier', { modifier: 'ctrl' }, { modifier: 'ctrl' }],
    ['transform', { transform: false }, { transform: false }],
    ['include as a string', { include: '**/*.tsx' }, { include: '**/*.tsx' }],
    [
      'include as an array',
      { include: ['a.tsx', 'b.tsx'] },
      { include: ['a.tsx', 'b.tsx'] },
    ],
    ['exclude', { exclude: ['**/vendor/**'] }, { exclude: ['**/vendor/**'] }],
    ['hosts', { hosts: ['localhost'] }, { hosts: ['localhost'] }],
  ]

  it.each(cases)('reads %s', (_label, written, expected) => {
    const { config, warnings } = readObject({ version: 1, ...(written as object) })

    expect(config).toEqual(expected)
    expect(warnings).toEqual([])
  })

  it('reads all of them at once, and reports them as the keys it supplied', () => {
    const { config, warnings } = readObject({
      version: 1,
      enabled: true,
      endpoint: '/__annotate',
      modifier: 'meta',
      transform: false,
      include: ['**/*.jsx'],
      exclude: ['**/dist/**'],
      hosts: ['localhost', '*.test'],
    })

    // Object.keys is what ./index.ts reports in its confirmation line, so the set matters as
    // much as the values.
    expect(Object.keys(config).sort()).toEqual([
      'enabled',
      'endpoint',
      'exclude',
      'hosts',
      'include',
      'modifier',
      'transform',
    ])
    expect(warnings).toEqual([])
  })
})

describe('a key that is present but wrong', () => {
  /** Each drops exactly the named key, warns once, and leaves the rest of the file alone. */
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['enabled', { enabled: 'yes' }],
    ['enabled', { enabled: 0 }],
    ['endpoint', { endpoint: 5 }],
    ['endpoint', { endpoint: '' }],
    ['endpoint', { endpoint: '   ' }],
    // Every shape `normaliseEndpoint` throws on. From a plugin option a throw is correct —
    // the author is reading the terminal. From this file it would take a dev server down
    // over committed data, which is the one thing this reader must never do, so the rule is
    // reused by *calling* it inside a catch rather than by restating it.
    ['endpoint', { endpoint: '/' }],
    ['endpoint', { endpoint: '//evil.com' }],
    ['endpoint', { endpoint: '/__dogear?a=1' }],
    ['endpoint', { endpoint: '/__dogear#x' }],
    ['modifier', { modifier: 'banana' }],
    ['modifier', { modifier: 3 }],
    ['transform', { transform: 'yes' }],
    ['include', { include: 5 }],
    ['include', { include: ['a.tsx', 7] }],
    ['exclude', { exclude: null }],
    ['hosts', { hosts: 'localhost' }],
    ['hosts', { hosts: { 0: 'localhost' } }],
  ]

  it.each(cases)('drops %s and warns, keeping every other key', (key, written) => {
    // `modifier: 'alt'` rides along to prove the drop is surgical: a bad key must not take
    // the file down with it, or one typo would cost every other setting.
    const { config, warnings } = readObject({
      version: 1,
      modifier: 'alt',
      ...(written as object),
    })

    expect(config).not.toHaveProperty(key)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(key)

    // The surgical half. `modifier` is itself the bad key in two rows, which is why this is
    // conditional rather than an unconditional assertion.
    if (key !== 'modifier') expect(config.modifier).toBe('alt')
  })

  it('does not throw, however wrong the value is', () => {
    // The rule this module exists for: a committed file is shared, so one person's typo must
    // not stop everyone else's dev server. A plugin *option* still throws — see
    // `validateModifier` in ./index.ts.
    write(JSON.stringify({ modifier: 'banana', hosts: 7, include: {} }))

    expect(() => read()).not.toThrow()
  })

  it('does not throw on an endpoint that `normaliseEndpoint` rejects', () => {
    // Found by ./index.test.ts, not predicted: `'/'` is a non-empty string, so an earlier
    // draft of this reader accepted it and let ./index.ts throw on it a few lines later —
    // a dev server killed by a data file, which is precisely the failure this ticket's
    // acceptance criteria rule out.
    for (const endpoint of ['/', '//evil.com', '/x?y']) {
      write(JSON.stringify({ endpoint }))

      expect(() => read()).not.toThrow()
      expect(read().config).not.toHaveProperty('endpoint')
    }
  })
})

describe('hosts', () => {
  it('honours an empty array as "nowhere"', () => {
    // Not read as absence. Someone who writes `[]` has said something, and F3's list replaces
    // the defaults rather than extending them — so an empty list allows nothing.
    const { config, warnings } = readObject({ version: 1, hosts: [] })

    expect(config.hosts).toEqual([])
    expect(warnings).toEqual([])
  })

  it('drops non-string entries and keeps the rest', () => {
    // Entry by entry rather than rejecting the list, because falling back to DEFAULT_HOSTS on
    // one bad entry would silently re-widen a list its author was narrowing.
    const { config, warnings } = readObject({ version: 1, hosts: ['localhost', 7, null] })

    expect(config.hosts).toEqual(['localhost'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('hosts')
  })

  it('names the entries it dropped', () => {
    const { warnings } = readObject({ version: 1, hosts: [42] })

    expect(warnings[0]).toContain('42')
  })
})

describe('unknown keys', () => {
  it('names a misspelling, since nothing else ever will', () => {
    const { config, warnings } = readObject({ version: 1, modifer: 'ctrl' })

    expect(config).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('modifer')
  })

  it('lists them all in one warning rather than one each', () => {
    const { warnings } = readObject({ version: 1, modifer: 'ctrl', endpont: '/x' })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('modifer')
    expect(warnings[0]).toContain('endpont')
  })

  it('still applies the keys it does recognise', () => {
    const { config } = readObject({ version: 1, modifier: 'ctrl', nonsense: true })

    expect(config.modifier).toBe('ctrl')
  })
})

describe('version', () => {
  it('is silent for 1 and for absent', () => {
    expect(readObject({ version: 1, modifier: 'ctrl' }).warnings).toEqual([])
    expect(readObject({ modifier: 'ctrl' }).warnings).toEqual([])
  })

  it('warns on a version from a future dogear but still reads what it knows', () => {
    // Refusing the whole file would cost a briefly-downgraded user every setting, to guard
    // against a schema change that has never happened.
    const { config, warnings } = readObject({ version: 2, modifier: 'ctrl' })

    expect(config).toEqual({ modifier: 'ctrl' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2')
  })
})

describe('a file that cannot be used at all', () => {
  it('reports unparseable JSON and falls back to plugin options', () => {
    write('{ "modifier": ')
    const { config, warnings } = read()

    expect(config).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('.dogear/config.json')
  })

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"ctrl"'],
    ['a number', '7'],
  ])('reports %s at the top level', (_label, contents) => {
    // All four are valid JSON, so the parse above waves them through — `typeof null` is
    // 'object', and an array's numeric keys would read as no keys rather than as an error.
    write(contents)
    const { config, warnings } = read()

    expect(config).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('JSON object')
  })

  it('reports a directory sitting where the file should be', () => {
    // The read fails with EISDIR rather than ENOENT, and the distinction is the whole reason
    // this module tests the error code instead of catching everything as "absent". A file
    // that exists and cannot be read is something the developer needs told.
    mkdirSync(join(gitRoot, '.dogear', 'config.json'), { recursive: true })
    const { config, warnings } = read()

    expect(config).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not read')
  })

  it('does not throw on any of them', () => {
    write('{{{')
    expect(() => read()).not.toThrow()
  })
})
