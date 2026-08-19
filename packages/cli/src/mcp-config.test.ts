import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Agent, Cli } from './detect.js'
import { createMcpStep, mcpRemovals } from './mcp-config.js'
import type { Plan, Wiring } from './scaffold.js'
import { createRepo, NO_DETECTION, removeRepo } from './test-repo.js'

/**
 * E3's (#28) baseline: the MCP server registered wherever the repository's agent will look.
 *
 * The assertion that carries the ticket is **"other servers survive byte for byte"** — a
 * parse-and-re-serialise implementation passes every structural check here and fails that one,
 * which is the whole reason ./json-insert.ts exists.
 */

let root: string

beforeEach(() => {
  root = createRepo('dogear-mcp-')
})

afterEach(() => {
  removeRepo(root)
})

function wiring(agents: readonly Agent[], cli: Cli = 'local'): Wiring {
  return { agents, hook: true, cli }
}

function plan(agents: readonly Agent[], cli: Cli = 'local'): Plan | undefined {
  return createMcpStep(wiring(agents, cli)).plan(root, NO_DETECTION)
}

/** Plan, apply, and hand back what is now on disk. */
function run(agents: readonly Agent[], file = '.mcp.json', cli: Cli = 'local'): string {
  plan(agents, cli)?.change?.apply()
  return read(file)
}

function read(file: string): string {
  return readFileSync(join(root, ...file.split('/')), 'utf8')
}

function seed(file: string, contents: string): void {
  const path = join(root, ...file.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

describe('createMcpStep() on a repository with no config', () => {
  const cases: readonly {
    readonly agent: Agent
    readonly file: string
    readonly key: string
  }[] = [
    { agent: 'claude', file: '.mcp.json', key: 'mcpServers' },
    { agent: 'cursor', file: '.cursor/mcp.json', key: 'mcpServers' },
    { agent: 'vscode', file: '.vscode/mcp.json', key: 'servers' },
  ]

  it.each(cases)('creates $file for $agent under $key', ({ agent, file, key }) => {
    const parsed = JSON.parse(run([agent], file)) as Record<string, unknown>

    expect(parsed[key]).toEqual({
      dogear: { command: 'node', args: ['node_modules/@dogear/cli/dist/cli.js', 'mcp'] },
    })
  })

  it('names every file it created in one summary', () => {
    expect(plan(['claude', 'cursor'])?.change?.summary).toBe(
      'registered dogear in .mcp.json, .cursor/mcp.json',
    )
  })

  it('creates nothing when no agent was selected', () => {
    expect(plan([])).toBeUndefined()
  })

  it('writes `node` and a relative path, never the bare `dogear` command', () => {
    const contents = run(['claude'])

    expect(contents).toContain('"command": "node"')
    expect(contents).not.toContain('"command": "dogear"')
    expect(contents).not.toMatch(/[A-Za-z]:[\\/]/)
  })
})

describe('createMcpStep() on a repository that already has one', () => {
  it('leaves an existing dogear entry alone', () => {
    seed(
      '.mcp.json',
      '{\n  "mcpServers": {\n    "dogear": { "command": "whatever" }\n  }\n}\n',
    )

    expect(plan(['claude'])).toBeUndefined()
  })

  it('adds dogear beside another server without disturbing it', () => {
    const before = [
      '{',
      '  "mcpServers": {',
      '    "other": { "command": "node", "args": ["x.js", "--flag"] }',
      '  }',
      '}',
      '',
    ].join('\n')
    seed('.mcp.json', before)

    const after = run(['claude'])
    const parsed = JSON.parse(after) as { mcpServers: Record<string, unknown> }

    expect(Object.keys(parsed.mcpServers)).toEqual(['other', 'dogear'])
    // The line the user wrote, byte for byte — only its trailing comma is new.
    expect(after).toContain(
      '    "other": { "command": "node", "args": ["x.js", "--flag"] },',
    )
  })

  it('adds the container when the file has none', () => {
    seed('.mcp.json', '{\n  "somethingElse": true\n}\n')

    const after = run(['claude'])
    const parsed = JSON.parse(after) as { somethingElse: boolean; mcpServers: object }

    expect(parsed.somethingElse).toBe(true)
    expect(parsed.mcpServers).toHaveProperty('dogear')
    expect(after).toContain('  "somethingElse": true,')
  })

  it('keeps a four-space file on four spaces', () => {
    seed('.mcp.json', '{\n    "mcpServers": {\n        "other": {}\n    }\n}\n')

    const after = run(['claude'])

    expect(after).toContain('\n        "other": {},')
    expect(after).toContain('\n        "dogear": {')
  })
})

describe('createMcpStep() when it cannot edit safely', () => {
  it('notes an unparseable file and changes nothing', () => {
    seed('.mcp.json', '{ this is not json }')

    const result = plan(['claude'])

    expect(result?.change).toBeUndefined()
    expect(result?.notes?.[0]).toContain('.mcp.json could not be parsed')
    expect(read('.mcp.json')).toBe('{ this is not json }')
  })

  it('notes a file with comments in it rather than reformatting it', () => {
    const before = '{\n  // ours\n  "mcpServers": {}\n}\n'
    seed('.mcp.json', before)

    const result = plan(['claude'])

    expect(result?.change).toBeUndefined()
    expect(result?.notes?.[0]).toContain('could not be parsed')
    expect(read('.mcp.json')).toBe(before)
  })

  it('still registers the agents it can when one file is broken', () => {
    seed('.mcp.json', 'nonsense')

    const result = plan(['claude', 'cursor'])

    expect(result?.change?.summary).toBe('registered dogear in .cursor/mcp.json')
    expect(result?.notes?.[0]).toContain('.mcp.json')
  })
})

describe('createMcpStep() reporting a missing local CLI', () => {
  it('notes it when there is something to register', () => {
    const result = plan(['claude'], 'absent')

    expect(result?.notes?.some((note) => note.includes('npm i -D @dogear/cli'))).toBe(
      true,
    )
  })

  it('says nothing when every config is already correct', () => {
    seed('.mcp.json', '{\n  "mcpServers": {\n    "dogear": {}\n  }\n}\n')

    expect(plan(['claude'], 'absent')).toBeUndefined()
  })
})

describe('createMcpStep() applying twice', () => {
  it('is a no-op the second time', () => {
    const step = createMcpStep(wiring(['claude']))

    step.plan(root, NO_DETECTION)?.change?.apply()
    const after = read('.mcp.json')

    expect(step.plan(root, NO_DETECTION)).toBeUndefined()
    expect(read('.mcp.json')).toBe(after)
  })

  it('does not write twice when the file gained the entry between plan and apply', () => {
    const planned = plan(['claude'])
    seed(
      '.mcp.json',
      '{\n  "mcpServers": {\n    "dogear": { "command": "mine" }\n  }\n}\n',
    )

    planned?.change?.apply()

    const parsed = JSON.parse(read('.mcp.json')) as {
      mcpServers: { dogear: { command: string } }
    }
    expect(parsed.mcpServers.dogear.command).toBe('mine')
  })
})

describe('unregistering the server — E6 (#39)', () => {
  /** Plan every target's removal and apply what each planned. */
  function undo(): readonly (Plan | undefined)[] {
    const plans = mcpRemovals.map((step) => step.plan(root))
    for (const planned of plans) planned?.change?.apply()
    return plans
  }

  it('deletes an .mcp.json that init created', () => {
    run(['claude'])

    expect(undo().find((planned) => planned !== undefined)?.change?.summary).toBe(
      'deleted .mcp.json',
    )
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
  })

  it('leaves other servers registered, byte for byte', () => {
    const before =
      '{\n  "mcpServers": {\n    "other": { "command": "node", "args": ["x.js"] }\n  }\n}\n'
    seed('.mcp.json', before)
    run(['claude'])

    undo()

    expect(read('.mcp.json')).toBe(before)
  })

  it('reaches every target, not just the one detection would pick today', () => {
    // The argument for undo being driven by TARGETS rather than by the Wiring: init with
    // --agent=cursor, delete `.cursor/`, and detection now says claude. A wiring-driven undo
    // walks straight past the file it wrote.
    run(['cursor'], '.cursor/mcp.json')
    run(['vscode'], '.vscode/mcp.json')

    undo()

    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(false)
    expect(existsSync(join(root, '.vscode', 'mcp.json'))).toBe(false)
  })

  it("does not remove the agent's own directory", () => {
    // `.cursor/` is the marker ./detect.ts reads to know the tool is used here at all, and an
    // empty one is inert. init creating it does not make removing it symmetric.
    run(['cursor'], '.cursor/mcp.json')

    undo()

    expect(existsSync(join(root, '.cursor'))).toBe(true)
  })

  it('handles the VS Code container, which is `servers` rather than `mcpServers`', () => {
    const before = '{\n  "servers": {\n    "other": { "command": "node" }\n  }\n}\n'
    seed('.vscode/mcp.json', before)
    run(['vscode'], '.vscode/mcp.json')

    undo()

    expect(read('.vscode/mcp.json')).toBe(before)
  })

  it('plans nothing when dogear was never registered', () => {
    seed('.mcp.json', '{\n  "mcpServers": {\n    "other": {}\n  }\n}\n')

    expect(mcpRemovals.map((step) => step.plan(root))).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it('leaves an unparseable file alone and says what to remove', () => {
    const broken = '{ "mcpServers": '
    seed('.mcp.json', broken)

    const notes = undo().flatMap((planned) => planned?.notes ?? [])

    expect(notes[0]).toContain('could not be parsed')
    expect(notes[0]).toContain('dogear')
    expect(read('.mcp.json')).toBe(broken)
  })
})
