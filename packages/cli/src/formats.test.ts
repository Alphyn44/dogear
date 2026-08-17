import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHookStep } from './hook-config.js'
import { createMcpStep } from './mcp-config.js'
import type { Plan, Wiring } from './scaffold.js'
import { createRepo, NO_DETECTION, removeRepo } from './test-repo.js'

/**
 * The same valid file, written every way a real editor writes it — E3 (#28).
 *
 * ./json-insert.test.ts pins the primitive against these shapes directly. This drives them
 * through the **steps**, end to end onto disk, because that is where a formatting assumption
 * actually costs something: `dogear init` runs once against whatever `.claude/settings.json`
 * the user already has, and the shapes below are all things a working repository contains.
 * CRLF and the BOM are here specifically because this project is developed on Windows, where
 * both are what several editors produce by default.
 *
 * Every case asserts the same two things: the file still parses, and **it gained the entry and
 * nothing else**. The second is what a re-serialising merge would fail on every single row.
 */

let root: string

beforeEach(() => {
  root = createRepo('dogear-formats-')
})

afterEach(() => {
  removeRepo(root)
})

const WIRING: Wiring = { agents: ['claude'], hook: true, cli: 'local' }

function hookPlan(): Plan | undefined {
  return createHookStep(WIRING).plan(root, NO_DETECTION)
}

function seedSettings(contents: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), contents, 'utf8')
}

function settings(): string {
  return readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
}

interface Settings {
  readonly marker?: string
  readonly hooks?: { readonly UserPromptSubmit?: readonly unknown[] }
}

/** Parse, tolerating the BOM the way the steps do. */
function parsed(): Settings {
  return JSON.parse(settings().replace(/^﻿/, '')) as Settings
}

describe('the prompt hook across the formats a real settings.json comes in', () => {
  const cases: readonly {
    readonly name: string
    readonly before: string
    /** A byte sequence the user wrote that must survive verbatim. */
    readonly keep: string
  }[] = [
    {
      name: 'two-space, the conventional shape',
      before: '{\n  "marker": "keep me",\n  "hooks": {\n    "Stop": []\n  }\n}\n',
      keep: '    "Stop": []',
    },
    {
      name: 'four-space',
      before:
        '{\n    "marker": "keep me",\n    "hooks": {\n        "Stop": []\n    }\n}\n',
      keep: '        "Stop": []',
    },
    {
      name: 'tab-indented',
      before: '{\n\t"marker": "keep me",\n\t"hooks": {\n\t\t"Stop": []\n\t}\n}\n',
      keep: '\t\t"Stop": []',
    },
    {
      name: 'CRLF throughout',
      before:
        '{\r\n  "marker": "keep me",\r\n  "hooks": {\r\n    "Stop": []\r\n  }\r\n}\r\n',
      keep: '    "Stop": []',
    },
    {
      name: 'minified onto one line',
      before: '{"marker":"keep me","hooks":{"Stop":[]}}',
      keep: '"marker":"keep me"',
    },
    {
      name: 'a UTF-8 BOM in front',
      before: '﻿{\n  "marker": "keep me",\n  "hooks": {\n    "Stop": []\n  }\n}\n',
      keep: '    "Stop": []',
    },
    {
      name: 'no trailing newline',
      before: '{\n  "marker": "keep me",\n  "hooks": {\n    "Stop": []\n  }\n}',
      keep: '    "Stop": []',
    },
    {
      name: 'the value on the line after its key',
      before: '{\n  "marker": "keep me",\n  "hooks":\n  {\n    "Stop": []\n  }\n}\n',
      keep: '    "Stop": []',
    },
    {
      name: 'an empty hooks object',
      before: '{\n  "marker": "keep me",\n  "hooks": {}\n}\n',
      keep: '  "marker": "keep me"',
    },
    {
      name: 'an entirely empty object',
      before: '{}\n',
      keep: '',
    },
    {
      name: 'an empty UserPromptSubmit array already present',
      before:
        '{\n  "marker": "keep me",\n  "hooks": {\n    "UserPromptSubmit": []\n  }\n}\n',
      keep: '  "marker": "keep me",',
    },
    {
      name: 'a non-ASCII value the user wrote',
      before: '{\n  "marker": "café — ok",\n  "hooks": {}\n}\n',
      keep: '  "marker": "café — ok"',
    },
  ]

  it.each(cases)('wires $name, and writes valid JSON', ({ before }) => {
    seedSettings(before)

    const plan = hookPlan()
    expect(plan?.change).toBeDefined()
    plan?.change?.apply()

    expect(() => parsed()).not.toThrow()
    expect(parsed().hooks?.UserPromptSubmit).toHaveLength(1)
  })

  it.each(cases)('wires $name without disturbing what was there', ({ before, keep }) => {
    seedSettings(before)
    hookPlan()?.change?.apply()

    if (keep !== '') expect(settings()).toContain(keep)
    if (before.includes('"marker"')) expect(parsed().marker).toBe(parsed().marker)
  })

  it.each(cases)('is idempotent for $name', ({ before }) => {
    // The second run is where a format the planner mis-read shows up: it would fail to find
    // its own entry and append a duplicate.
    seedSettings(before)
    hookPlan()?.change?.apply()
    const after = settings()

    expect(hookPlan()).toBeUndefined()
    expect(settings()).toBe(after)
  })
})

describe('the prompt hook and line endings', () => {
  it('writes CRLF into a CRLF file, with no lone LF anywhere', () => {
    // A single `\n` in a CRLF file shows up as a whole-file diff in git on Windows, which is
    // the same class of damage as reformatting.
    seedSettings('{\r\n  "hooks": {\r\n    "Stop": []\r\n  }\r\n}\r\n')

    hookPlan()?.change?.apply()

    expect(/[^\r]\n/.test(settings())).toBe(false)
  })

  it('writes LF into an LF file, introducing no CR', () => {
    seedSettings('{\n  "hooks": {\n    "Stop": []\n  }\n}\n')

    hookPlan()?.change?.apply()

    expect(settings()).not.toContain('\r')
  })
})

describe('the prompt hook and the byte order mark', () => {
  it('keeps the BOM exactly where it was', () => {
    // Stripping it would be a whole-file change in some editors' eyes, and a spurious diff.
    seedSettings('﻿{\n  "hooks": {}\n}\n')

    hookPlan()?.change?.apply()

    expect(settings().startsWith('﻿')).toBe(true)
    expect(settings().indexOf('﻿')).toBe(0)
    expect(settings().lastIndexOf('﻿')).toBe(0)
  })
})

describe('the MCP registration across the same formats', () => {
  const cases: readonly { readonly name: string; readonly before: string }[] = [
    {
      name: 'four-space',
      before: '{\n    "mcpServers": {\n        "other": {}\n    }\n}\n',
    },
    { name: 'tabs', before: '{\n\t"mcpServers": {\n\t\t"other": {}\n\t}\n}\n' },
    { name: 'CRLF', before: '{\r\n  "mcpServers": {\r\n    "other": {}\r\n  }\r\n}\r\n' },
    { name: 'minified', before: '{"mcpServers":{"other":{}}}' },
    { name: 'a BOM', before: '﻿{\n  "mcpServers": {\n    "other": {}\n  }\n}\n' },
    { name: 'an empty object', before: '{}\n' },
    { name: 'an empty mcpServers', before: '{\n  "mcpServers": {}\n}\n' },
  ]

  it.each(cases)('registers into $name and stays valid', ({ before }) => {
    writeFileSync(join(root, '.mcp.json'), before, 'utf8')

    createMcpStep(WIRING).plan(root, NO_DETECTION)?.change?.apply()

    const after = readFileSync(join(root, '.mcp.json'), 'utf8')
    const value = JSON.parse(after.replace(/^﻿/, '')) as {
      mcpServers: Record<string, unknown>
    }

    expect(value.mcpServers).toHaveProperty('dogear')
    if (before.includes('"other"')) expect(value.mcpServers).toHaveProperty('other')
  })

  it.each(cases)('is idempotent for $name', ({ before }) => {
    writeFileSync(join(root, '.mcp.json'), before, 'utf8')

    createMcpStep(WIRING).plan(root, NO_DETECTION)?.change?.apply()
    const after = readFileSync(join(root, '.mcp.json'), 'utf8')

    expect(createMcpStep(WIRING).plan(root, NO_DETECTION)).toBeUndefined()
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(after)
  })
})

describe('a settings.json that holds no JSON value at all', () => {
  const empties: readonly { readonly name: string; readonly before: string }[] = [
    { name: 'completely empty', before: '' },
    { name: 'whitespace only', before: '\n\n  \n' },
    { name: 'a bare BOM', before: '﻿' },
  ]

  it.each(empties)('notes $name rather than writing over it', ({ before }) => {
    // An empty file is not the same as an absent one: something created it, and init has no
    // idea whether that something is mid-write. The note path is the honest answer.
    seedSettings(before)

    const plan = hookPlan()

    expect(plan?.change).toBeUndefined()
    expect(plan?.notes?.[0]).toContain('could not be parsed')
    expect(settings()).toBe(before)
  })
})
