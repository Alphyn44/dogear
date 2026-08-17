import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHookStep } from './hook-config.js'
import { createMcpStep } from './mcp-config.js'
import type { Plan, Wiring } from './scaffold.js'
import { createRepo, NO_DETECTION, removeRepo } from './test-repo.js'

/**
 * The shapes an agent config can be in that are **valid JSON but not what init expects** —
 * E3 (#28).
 *
 * The suites beside this one cover the happy structures and the unreadable ones. This is the
 * band between: a file that parses cleanly, that a user or another tool wrote, where the key
 * init wants is present and holds the wrong kind of value. It is a band worth its own file
 * because the failure mode is unique to it — every other bad input fails the parse and lands on
 * the note path, while these get all the way to a splice and produce a file that still parses.
 *
 * **A duplicate key is the specific danger.** `{"hooks": "x"}` is not an object, so a naive
 * merge inserts a *second* `"hooks"` key beside it. `JSON.parse` accepts duplicates and keeps
 * the last, so the parse check that guards every other path waves it through — and the user
 * ends up with a settings file that silently shadows what they wrote. Declining is the only
 * correct answer: init cannot know whether that string was a typo to route around or data it
 * would be destroying.
 */

let root: string

beforeEach(() => {
  root = createRepo('dogear-malformed-')
})

afterEach(() => {
  removeRepo(root)
})

const WIRING: Wiring = { agents: ['claude'], hook: true, cli: 'local' }

function hookPlan(): Plan | undefined {
  return createHookStep(WIRING).plan(root, NO_DETECTION)
}

function mcpPlan(): Plan | undefined {
  return createMcpStep(WIRING).plan(root, NO_DETECTION)
}

function seedSettings(contents: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), contents, 'utf8')
}

function settings(): string {
  return readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
}

function seedMcp(contents: string): void {
  writeFileSync(join(root, '.mcp.json'), contents, 'utf8')
}

function occurrences(source: string, key: string): number {
  return (source.match(new RegExp(`"${key}"`, 'g')) ?? []).length
}

describe('the prompt hook against a settings.json with wrong-typed keys', () => {
  const cases: readonly { readonly name: string; readonly contents: string }[] = [
    { name: 'hooks is a string', contents: '{\n  "hooks": "nope"\n}\n' },
    { name: 'hooks is null', contents: '{\n  "hooks": null\n}\n' },
    { name: 'hooks is an array', contents: '{\n  "hooks": []\n}\n' },
    {
      name: 'UserPromptSubmit is a string',
      contents: '{\n  "hooks": {\n    "UserPromptSubmit": "nope"\n  }\n}\n',
    },
    {
      name: 'UserPromptSubmit is an object',
      contents: '{\n  "hooks": {\n    "UserPromptSubmit": {}\n  }\n}\n',
    },
    {
      name: 'UserPromptSubmit is null',
      contents: '{\n  "hooks": {\n    "UserPromptSubmit": null\n  }\n}\n',
    },
  ]

  it.each(cases)('declines and notes when $name', ({ contents }) => {
    seedSettings(contents)

    const result = hookPlan()

    expect(result?.change).toBeUndefined()
    expect(result?.notes?.[0]).toContain('.claude/settings.json')
    expect(settings()).toBe(contents)
  })

  it.each(cases)('never writes a duplicate key when $name', ({ contents }) => {
    // The assertion this file exists for. A duplicate survives `JSON.parse`, so the guard that
    // catches every other bad splice cannot catch this one.
    seedSettings(contents)

    hookPlan()?.change?.apply()

    expect(occurrences(settings(), 'hooks')).toBeLessThanOrEqual(1)
    expect(occurrences(settings(), 'UserPromptSubmit')).toBeLessThanOrEqual(1)
  })
})

describe('the MCP registration against a config with wrong-typed keys', () => {
  const cases: readonly { readonly name: string; readonly contents: string }[] = [
    { name: 'mcpServers is null', contents: '{\n  "mcpServers": null\n}\n' },
    { name: 'mcpServers is a string', contents: '{\n  "mcpServers": "nope"\n}\n' },
    { name: 'mcpServers is an array', contents: '{\n  "mcpServers": []\n}\n' },
  ]

  it.each(cases)('declines and leaves the file alone when $name', ({ contents }) => {
    seedMcp(contents)

    const result = mcpPlan()

    expect(result?.change).toBeUndefined()
    expect(result?.notes?.[0]).toContain('.mcp.json')
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(contents)
  })

  it.each(cases)('never writes a duplicate key when $name', ({ contents }) => {
    seedMcp(contents)

    mcpPlan()?.change?.apply()

    expect(occurrences(readFileSync(join(root, '.mcp.json'), 'utf8'), 'mcpServers')).toBe(
      1,
    )
  })
})
