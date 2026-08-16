import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Agent } from './detect.js'
import { createHookStep } from './hook-config.js'
import type { Plan, Wiring } from './scaffold.js'
import { createRepo, NO_DETECTION, removeRepo } from './test-repo.js'

/**
 * Claude Code's prompt hook — E3 (#28), the tier on top of MCP.
 *
 * **"Existing hooks survive" is the criterion this suite exists for**, and it is tested against
 * the shape that actually breaks: a hand-formatted `settings.json` with one-line hook objects
 * inside a nested array, which is what this repository's own file looks like. A merge that
 * parsed and re-serialised would satisfy every structural assertion below and fail the byte
 * ones.
 */

const SETTINGS = '.claude/settings.json'

let root: string

beforeEach(() => {
  root = createRepo('dogear-hook-')
})

afterEach(() => {
  removeRepo(root)
})

function wiring(over: Partial<Wiring> = {}): Wiring {
  return { agents: ['claude'] as readonly Agent[], hook: true, cli: 'local', ...over }
}

function plan(over: Partial<Wiring> = {}): Plan | undefined {
  return createHookStep(wiring(over)).plan(root, NO_DETECTION)
}

function run(over: Partial<Wiring> = {}): string {
  plan(over)?.change?.apply()
  return read()
}

function read(): string {
  return readFileSync(join(root, ...SETTINGS.split('/')), 'utf8')
}

function seed(contents: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, ...SETTINGS.split('/')), contents, 'utf8')
}

interface Settings {
  readonly hooks?: {
    readonly UserPromptSubmit?: readonly {
      readonly hooks?: readonly {
        readonly command?: string
        readonly args?: readonly string[]
      }[]
    }[]
  }
}

function entries(contents: string): readonly unknown[] {
  return (JSON.parse(contents) as Settings).hooks?.UserPromptSubmit ?? []
}

describe('createHookStep() writing the entry', () => {
  it('creates the file when the repository has no settings', () => {
    expect(plan()?.change?.summary).toBe('created .claude/settings.json')

    const after = run()
    const parsed = JSON.parse(after) as Settings
    const command = parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]

    expect(command?.command).toBe('node')
    expect(command?.args).toEqual([
      '${CLAUDE_PROJECT_DIR}/node_modules/@dogear/cli/dist/cli.js',
      'hook',
    ])
  })

  it('writes `node` plus a path, never the bare `dogear` command', () => {
    const after = run()

    expect(after).toContain('"command": "node"')
    expect(after).not.toContain('"command": "dogear"')
  })

  it('writes timeout 10, against the event’s 30s default', () => {
    expect(JSON.parse(run()) as unknown).toMatchObject({
      hooks: { UserPromptSubmit: [{ hooks: [{ timeout: 10 }] }] },
    })
  })
})

describe('createHookStep() merging into what is there', () => {
  it('adds the hooks key when the file has none', () => {
    seed('{\n  "permissions": {\n    "allow": ["Read"]\n  }\n}\n')

    const after = run()

    expect(entries(after)).toHaveLength(1)
    expect(after).toContain('    "allow": ["Read"]')
  })

  it('adds UserPromptSubmit beside another event', () => {
    seed('{\n  "hooks": {\n    "Stop": [{ "hooks": [] }]\n  }\n}\n')

    const after = run()

    expect(entries(after)).toHaveLength(1)
    expect(after).toContain('    "Stop": [{ "hooks": [] }],')
  })

  it('appends to an existing UserPromptSubmit array without replacing it', () => {
    const before = [
      '{',
      '  "hooks": {',
      '    "UserPromptSubmit": [',
      '      {',
      '        "hooks": [{ "type": "command", "command": "bash \\"chime.sh\\"" }]',
      '      }',
      '    ]',
      '  }',
      '}',
      '',
    ].join('\n')
    seed(before)

    expect(plan()?.change?.summary).toBe(
      'merged the prompt hook into .claude/settings.json',
    )

    const after = run()

    expect(entries(after)).toHaveLength(2)
    // The user's entry, byte for byte.
    expect(after).toContain(
      '        "hooks": [{ "type": "command", "command": "bash \\"chime.sh\\"" }]',
    )
  })

  it('leaves every unrelated section of a dense settings file untouched', () => {
    const before = [
      '{',
      '  "permissions": {',
      '    "allow": ["Read", "Glob"],',
      '    "deny": ["Bash(curl:*)"]',
      '  },',
      '  "hooks": {',
      '    "PreToolUse": [',
      '      { "matcher": "Bash", "hooks": [{ "command": "bash \\"a}b.sh\\"" }] }',
      '    ],',
      '    "UserPromptSubmit": [{ "hooks": [{ "command": "bash \\"c.sh\\"" }] }]',
      '  }',
      '}',
      '',
    ].join('\n')
    seed(before)

    const after = run()

    for (const line of [
      '    "allow": ["Read", "Glob"],',
      '    "deny": ["Bash(curl:*)"]',
    ]) {
      expect(after).toContain(line)
    }
    // A closing brace inside a string never confused the scanner.
    expect(after).toContain(
      '{ "matcher": "Bash", "hooks": [{ "command": "bash \\"a}b.sh\\"" }] }',
    )
    expect(entries(after)).toHaveLength(2)
  })
})

describe('createHookStep() declining', () => {
  it('does nothing when --no-hook was given', () => {
    expect(plan({ hook: false })).toBeUndefined()
  })

  it('does nothing when Claude Code is not among the agents', () => {
    expect(plan({ agents: ['cursor'] })).toBeUndefined()
  })

  it('notes an unparseable file and says MCP still works', () => {
    seed('{ not json')

    const result = plan()

    expect(result?.change).toBeUndefined()
    expect(result?.notes?.[0]).toContain('could not be parsed')
    expect(result?.notes?.[0]).toContain('MCP still works')
    expect(read()).toBe('{ not json')
  })

  it('notes a commented file rather than reformatting it', () => {
    const before = '{\n  // mine\n  "hooks": {}\n}\n'
    seed(before)

    expect(plan()?.change).toBeUndefined()
    expect(read()).toBe(before)
  })
})

describe('createHookStep() re-running', () => {
  it('is a no-op once the hook is there', () => {
    run()
    const after = read()

    expect(plan()).toBeUndefined()
    expect(read()).toBe(after)
  })

  it('recognises the hook even when the user changed its timeout', () => {
    seed(
      '{\n  "hooks": {\n    "UserPromptSubmit": [{ "hooks": [{ "command": "node", ' +
        '"args": ["${CLAUDE_PROJECT_DIR}/node_modules/@dogear/cli/dist/cli.js", "hook"], ' +
        '"timeout": 30 }] }]\n  }\n}\n',
    )

    expect(plan()).toBeUndefined()
  })

  it('does not confuse another tool’s UserPromptSubmit hook for its own', () => {
    seed(
      '{\n  "hooks": {\n    "UserPromptSubmit": [{ "hooks": [{ "command": "node", ' +
        '"args": ["other.js", "hook"] }] }]\n  }\n}\n',
    )

    expect(plan()?.change).toBeDefined()
  })

  it('does not write twice when the hook arrived between plan and apply', () => {
    const planned = plan()
    seed(
      '{\n  "hooks": {\n    "UserPromptSubmit": [{ "hooks": [{ "command": "node", ' +
        '"args": ["node_modules/@dogear/cli/dist/cli.js", "hook"] }] }]\n  }\n}\n',
    )

    planned?.change?.apply()

    expect(entries(read())).toHaveLength(1)
  })
})
