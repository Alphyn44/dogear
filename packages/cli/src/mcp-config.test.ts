import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Agent } from './detect.js'
import { CLI_ENTRY, cliEntry } from './detect.js'
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

/** The path #75's layout writes: a repository whose only package is `web/`. */
const WEB = cliEntry('web')

function wiring(agents: readonly Agent[], entry = CLI_ENTRY): Wiring {
  return { agents, hook: true, entry, withheld: [] }
}

function plan(agents: readonly Agent[], entry = CLI_ENTRY): Plan | undefined {
  return createMcpStep(wiring(agents, entry)).plan(root, NO_DETECTION)
}

/** Plan, apply, and hand back what is now on disk. */
function run(agents: readonly Agent[], file = '.mcp.json', entry = CLI_ENTRY): string {
  plan(agents, entry)?.change?.apply()
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
      dogear: { command: 'node', args: ['node_modules/dogear-cli/dist/cli.js', 'mcp'] },
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
    const before =
      '{\n  "mcpServers": {\n    "dogear": { "command": "whatever" }\n  }\n}\n'
    seed('.mcp.json', before)

    // Left alone, and since #75 not silently: this entry names no CLI path at all, which is a
    // path other than the one init would write, so it earns the stale note. See the stale suite.
    const result = plan(['claude'])

    expect(result?.change).toBeUndefined()
    expect(result?.notes).toHaveLength(1)
    expect(read('.mcp.json')).toBe(before)
  })

  it('plans nothing over an entry naming exactly the path init would write', () => {
    run(['claude'])

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

/**
 * An absent local `dogear-cli` used to be noted *here*, gated on a registration being
 * written — so it fired on the run that created `.mcp.json` and never again. G3 (#44) moved it
 * to ./scaffold.ts's `remarks()`: it describes the repository rather than what this step did,
 * which is what lets it print on every run without suppressing `nothing changed`. The cases
 * live in ./scaffold.test.ts now; this one pins that the step itself stays out of it.
 *
 * Since #75 the step cannot see install state at all (`Wiring` carries the path, not whether
 * anything is installed at it), so what is left to pin is that a fresh registration notes nothing.
 */
describe('createMcpStep() and a missing local CLI', () => {
  it('says nothing about installing it; the remark is scaffold’s', () => {
    expect(plan(['claude'])?.notes ?? []).toEqual([])
    expect(plan(['claude'], WEB)?.notes ?? []).toEqual([])
  })
})

describe('createMcpStep() in a repository whose only package is web/ (#75)', () => {
  it.each([
    { agent: 'claude' as const, file: '.mcp.json', key: 'mcpServers' },
    { agent: 'cursor' as const, file: '.cursor/mcp.json', key: 'mcpServers' },
    { agent: 'vscode' as const, file: '.vscode/mcp.json', key: 'servers' },
  ])('writes the web/ path into $file', ({ agent, file, key }) => {
    const parsed = JSON.parse(run([agent], file, WEB)) as Record<string, unknown>

    expect(parsed[key]).toEqual({
      dogear: {
        command: 'node',
        args: ['web/node_modules/dogear-cli/dist/cli.js', 'mcp'],
      },
    })
  })

  it('is a no-op the second time', () => {
    run(['claude'], '.mcp.json', WEB)

    expect(plan(['claude'], WEB)).toBeUndefined()
  })

  it('names the web/ path in the note when the file cannot be edited', () => {
    seed('.mcp.json', '{ nope')

    expect(plan(['claude'], WEB)?.notes?.[0]).toContain(`["${WEB}", "mcp"]`)
  })
})

/**
 * #75's migration case: a repository set up before the fix carries the root's path, and a re-run
 * after it must not report `nothing changed` over a registration that never resolves.
 */
describe('createMcpStep() over a registration naming another path (#75)', () => {
  it('notes both paths and the repair, and changes nothing', () => {
    run(['claude'])
    const before = read('.mcp.json')

    const result = plan(['claude'], WEB)

    expect(result?.change).toBeUndefined()
    expect(result?.notes).toEqual([
      `.mcp.json registers "dogear" at ${CLI_ENTRY}, but this repository's dogear-cli ` +
        `belongs at ${WEB}. Run \`dogear init --undo\` and then \`dogear init\` to repoint it.`,
    ])
    expect(read('.mcp.json')).toBe(before)
  })

  it('notes each file that is stale, and registers the ones that are missing', () => {
    run(['claude'])

    const result = plan(['claude', 'cursor'], WEB)

    expect(result?.change?.summary).toBe('registered dogear in .cursor/mcp.json')
    expect(result?.notes).toHaveLength(1)
    expect(result?.notes?.[0]).toMatch(/^\.mcp\.json registers/)
  })

  it('says so when the entry names no path it can read', () => {
    seed(
      '.mcp.json',
      '{\n  "mcpServers": {\n    "dogear": { "command": "npx" }\n  }\n}\n',
    )

    expect(plan(['claude'])?.notes?.[0]).toContain(
      'registers "dogear" without a CLI path dogear can read',
    )
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

  // #75. Undo never runs detection, so it cannot know init chose web/. Comparing against the
  // root's fresh file alone would splice this one to `{}` instead of deleting it.
  it('deletes a file init wrote whole with the web/ path', () => {
    run(['claude'], '.mcp.json', WEB)

    expect(undo().find((planned) => planned !== undefined)?.change?.summary).toBe(
      'deleted .mcp.json',
    )
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
  })

  it('splices, rather than deletes, a web/ registration beside another server', () => {
    const before = '{\n  "mcpServers": {\n    "other": { "command": "node" }\n  }\n}\n'
    seed('.mcp.json', before)
    run(['claude'], '.mcp.json', WEB)

    undo()

    expect(read('.mcp.json')).toBe(before)
  })
})
