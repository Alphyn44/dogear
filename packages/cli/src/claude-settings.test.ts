import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ALLOW,
  claudeSettingsRemoval,
  createClaudeSettingsStep,
} from './claude-settings.js'
import type { Agent } from './detect.js'
import { CLI_ENTRY, cliEntry } from './detect.js'
import type { Plan, Wiring } from './scaffold.js'
import { createRepo, NO_DETECTION, removeRepo } from './test-repo.js'
import { TOOLS } from './tools.js'

/**
 * Everything dogear writes into `.claude/settings.json`: the prompt hook (E3, #28) and the
 * permission rules that pre-approve its MCP tools (#76).
 *
 * **"Existing hooks survive" is the criterion this suite was written for**, and it is tested
 * against the shape that actually breaks: a hand-formatted `settings.json` with one-line hook
 * objects inside a nested array, which is what this repository's own file looks like. A merge
 * that parsed and re-serialised would satisfy every structural assertion below and fail the byte
 * ones. #76 added the same requirement for someone else's allow rules.
 */

const SETTINGS = '.claude/settings.json'

let root: string

beforeEach(() => {
  root = createRepo('dogear-settings-')
})

afterEach(() => {
  removeRepo(root)
})

/** The path #75's layout writes: a repository whose only package is `web/`. */
const WEB = cliEntry('web')

/** The hook argument init writes for the root's path. */
const ARG = `\${CLAUDE_PROJECT_DIR}/${CLI_ENTRY}`

function wiring(over: Partial<Wiring> = {}): Wiring {
  return {
    agents: ['claude'] as readonly Agent[],
    hook: true,
    entry: CLI_ENTRY,
    withheld: [],
    ...over,
  }
}

function plan(over: Partial<Wiring> = {}): Plan | undefined {
  return createClaudeSettingsStep(wiring(over)).plan(root, NO_DETECTION)
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
  readonly permissions?: {
    readonly allow?: readonly string[]
    readonly ask?: readonly string[]
    readonly deny?: readonly string[]
  }
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

function allow(contents: string): readonly string[] | undefined {
  return (JSON.parse(contents) as Settings).permissions?.allow
}

/** A settings file holding dogear's hook and nothing else, as every init before #76 wrote it. */
function hookOnly(arg = ARG): string {
  const hooks = [{ type: 'command', command: 'node', args: [arg, 'hook'], timeout: 10 }]
  return `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks }] } }, null, 2)}\n`
}

describe('createClaudeSettingsStep() writing a new file', () => {
  it('creates the file when the repository has no settings', () => {
    expect(plan()?.change?.summary).toBe('created .claude/settings.json')

    const after = run()
    const parsed = JSON.parse(after) as Settings
    const command = parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]

    expect(command?.command).toBe('node')
    expect(command?.args).toEqual([
      '${CLAUDE_PROJECT_DIR}/node_modules/dogear-cli/dist/cli.js',
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

  it("allows dogear's three tools by name, ahead of the hook", () => {
    const after = run()

    expect(allow(after)).toEqual([
      'mcp__dogear__dogear_pending',
      'mcp__dogear__dogear_resolve',
      'mcp__dogear__dogear_prune',
    ])
    expect(after.indexOf('"permissions"')).toBeLessThan(after.indexOf('"hooks"'))
  })

  it('writes only the permission rules under --no-hook', () => {
    expect(plan({ hook: false })?.change?.summary).toBe('created .claude/settings.json')

    const parsed = JSON.parse(run({ hook: false })) as Settings

    expect(parsed.permissions?.allow).toEqual(ALLOW)
    expect(parsed.hooks).toBeUndefined()
  })
})

describe("the permission rules name exactly dogear's MCP tools (#76)", () => {
  // The rules are a literal on purpose: deriving them from TOOLS would pre-approve a new tool the
  // moment it shipped. This is what makes adding one a decision rather than a side effect.
  it('pairs one rule with every tool the server exposes, in both directions', () => {
    expect([...ALLOW].sort()).toEqual(
      TOOLS.map((tool) => `mcp__dogear__${tool.name}`).sort(),
    )
  })
})

describe('createClaudeSettingsStep() merging into what is there', () => {
  it('adds the hooks key when the file has none', () => {
    seed('{\n  "permissions": {\n    "allow": ["Read"]\n  }\n}\n')

    const after = run()

    expect(entries(after)).toHaveLength(1)
    expect(after).toContain('    "allow": ["Read",')
  })

  it("joins an existing allow list, keeping the user's rules first", () => {
    seed('{\n  "permissions": {\n    "allow": [\n      "Read"\n    ]\n  }\n}\n')

    const after = run()

    expect(allow(after)).toEqual(['Read', ...ALLOW])
    expect(after).toContain(
      '    "allow": [\n      "Read",\n      "mcp__dogear__dogear_pending",',
    )
  })

  it('adds allow beside ask and deny without touching them', () => {
    seed('{\n  "permissions": {\n    "deny": ["Bash(curl:*)"]\n  }\n}\n')

    const after = run({ hook: false })

    expect(allow(after)).toEqual(ALLOW)
    expect(after).toContain('    "deny": ["Bash(curl:*)"],')
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
      "merged the prompt hook and dogear's MCP tool permissions into .claude/settings.json",
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
      '    "allow": ["Read", "Glob",',
      '    "deny": ["Bash(curl:*)"]',
    ]) {
      expect(after).toContain(line)
    }
    // A closing brace inside a string never confused the scanner.
    expect(after).toContain(
      '{ "matcher": "Bash", "hooks": [{ "command": "bash \\"a}b.sh\\"" }] }',
    )
    expect(entries(after)).toHaveLength(2)
    expect(allow(after)).toEqual(['Read', 'Glob', ...ALLOW])
  })
})

describe('createClaudeSettingsStep() reporting only what it adds', () => {
  const cases: readonly {
    readonly name: string
    readonly before: string
    readonly hook?: boolean
    /** The change line, or `undefined` for a file with nothing to add. */
    readonly summary: string | undefined
  }[] = [
    {
      name: 'a file init wrote before #76 gains the rules alone',
      before: hookOnly(),
      summary: "added dogear's MCP tool permissions to .claude/settings.json",
    },
    {
      name: 'a file init wrote under --no-hook gains the hook alone',
      before: `${JSON.stringify({ permissions: { allow: ALLOW } }, null, 2)}\n`,
      summary: 'merged the prompt hook into .claude/settings.json',
    },
    {
      name: 'a file with neither gains both',
      before: '{\n  "model": "opus"\n}\n',
      summary:
        "merged the prompt hook and dogear's MCP tool permissions into .claude/settings.json",
    },
    {
      name: '--no-hook adds the rules and leaves the hook out',
      before: '{\n  "model": "opus"\n}\n',
      hook: false,
      summary: "added dogear's MCP tool permissions to .claude/settings.json",
    },
    {
      name: 'a legacy file under --no-hook still gains the rules',
      before: hookOnly(),
      hook: false,
      summary: "added dogear's MCP tool permissions to .claude/settings.json",
    },
  ]

  it.each(cases)('$name', ({ before, hook = true, summary }) => {
    seed(before)

    expect(plan({ hook })?.change?.summary).toBe(summary)

    run({ hook })

    // And the second run is the verdict the report owes a finished repository.
    expect(plan({ hook })).toBeUndefined()
  })
})

describe('createClaudeSettingsStep() leaving a decision it finds alone (#76)', () => {
  // Every row already carries the hook, so the only thing a plan could add is the rules. Any
  // rule about dogear's server means someone decided, and topping it up would override them.
  const cases: readonly { readonly name: string; readonly permissions: unknown }[] = [
    { name: 'the rules init writes', permissions: { allow: ALLOW } },
    { name: 'a server wildcard in allow', permissions: { allow: ['mcp__dogear__*'] } },
    { name: 'the bare server name in allow', permissions: { allow: ['mcp__dogear'] } },
    {
      name: 'one tool deleted from allow',
      permissions: {
        allow: ['mcp__dogear__dogear_pending', 'mcp__dogear__dogear_resolve'],
      },
    },
    {
      name: 'one tool moved to deny',
      permissions: { deny: ['mcp__dogear__dogear_prune'] },
    },
    {
      name: 'one tool moved to ask',
      permissions: { ask: ['mcp__dogear__dogear_resolve'] },
    },
  ]

  it.each(cases)('plans nothing over $name', ({ permissions }) => {
    const parsed = JSON.parse(hookOnly()) as Record<string, unknown>
    seed(`${JSON.stringify({ permissions, ...parsed }, null, 2)}\n`)

    expect(plan()).toBeUndefined()
  })

  it("does not mistake another server's rule for dogear's", () => {
    const parsed = JSON.parse(hookOnly()) as Record<string, unknown>
    seed(
      `${JSON.stringify({ permissions: { allow: ['mcp__dogearish__x'] }, ...parsed }, null, 2)}\n`,
    )

    expect(plan()?.change?.summary).toBe(
      "added dogear's MCP tool permissions to .claude/settings.json",
    )
  })
})

describe('createClaudeSettingsStep() declining', () => {
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

  it('says only what it declined under --no-hook', () => {
    seed('{ not json')

    const note = plan({ hook: false })?.notes?.[0]

    expect(note).toContain("allowed none of dogear's MCP tools")
    expect(note).not.toContain('prompt hook')
  })

  it('notes a commented file rather than reformatting it', () => {
    const before = '{\n  // mine\n  "hooks": {}\n}\n'
    seed(before)

    expect(plan()?.change).toBeUndefined()
    expect(read()).toBe(before)
  })
})

describe('createClaudeSettingsStep() re-running', () => {
  it('is a no-op once both parts are there', () => {
    run()
    const after = read()

    expect(plan()).toBeUndefined()
    expect(read()).toBe(after)
  })

  it('recognises the hook even when the user changed its timeout', () => {
    seed(
      '{\n  "hooks": {\n    "UserPromptSubmit": [{ "hooks": [{ "command": "node", ' +
        '"args": ["${CLAUDE_PROJECT_DIR}/node_modules/dogear-cli/dist/cli.js", "hook"], ' +
        '"timeout": 30 }] }]\n  }\n}\n',
    )

    // The rules are still missing, so there is work, but it is not a second hook.
    expect(plan()?.change?.summary).toBe(
      "added dogear's MCP tool permissions to .claude/settings.json",
    )
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
        '"args": ["node_modules/dogear-cli/dist/cli.js", "hook"] }] }]\n  }\n}\n',
    )

    planned?.change?.apply()

    expect(entries(read())).toHaveLength(1)
    expect(allow(read())).toEqual(ALLOW)
  })

  it('does nothing when everything it planned arrived between plan and apply', () => {
    seed('{\n  "model": "opus"\n}\n')
    const planned = plan()

    run()
    const after = read()
    planned?.change?.apply()

    expect(read()).toBe(after)
  })
})

describe('createClaudeSettingsStep() in a repository whose only package is web/ (#75)', () => {
  it('runs the hook through the web/ path', () => {
    const parsed = JSON.parse(run({ entry: WEB })) as Settings

    expect(parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.args).toEqual([
      '${CLAUDE_PROJECT_DIR}/web/node_modules/dogear-cli/dist/cli.js',
      'hook',
    ])
  })

  it('is a no-op the second time', () => {
    run({ entry: WEB })

    expect(plan({ entry: WEB })).toBeUndefined()
  })

  it('names the web/ path in the note when the hook cannot be placed', () => {
    seed('{\n  "hooks": "x"\n}\n')

    expect(plan({ entry: WEB })?.notes?.[0]).toContain(
      '`node ${CLAUDE_PROJECT_DIR}/web/node_modules/dogear-cli/dist/cli.js hook`',
    )
  })

  // The migration case, and the reason #75 went unseen: a hook running the root's path is
  // `wired()`, so without this a re-run reported `nothing changed` over a hook that failed on
  // every prompt.
  it('notes a hook running another path, and changes nothing', () => {
    run()
    const before = read()

    const result = plan({ entry: WEB })

    expect(result?.change).toBeUndefined()
    expect(result?.notes).toEqual([
      '.claude/settings.json runs the prompt hook from ' +
        '${CLAUDE_PROJECT_DIR}/node_modules/dogear-cli/dist/cli.js, but this ' +
        "repository's dogear-cli belongs at " +
        '${CLAUDE_PROJECT_DIR}/web/node_modules/dogear-cli/dist/cli.js. Run ' +
        '`dogear init --undo` and then `dogear init` to repoint it.',
    ])
    expect(read()).toBe(before)
  })

  it('still adds the rules beside a stale hook, and notes the hook', () => {
    seed(hookOnly())

    const result = plan({ entry: WEB })

    expect(result?.change?.summary).toBe(
      "added dogear's MCP tool permissions to .claude/settings.json",
    )
    expect(result?.notes?.[0]).toContain('runs the prompt hook from')
  })
})

describe('taking dogear back out — E6 (#39)', () => {
  function undo(): Plan | undefined {
    const planned = claudeSettingsRemoval.plan(root)
    planned?.change?.apply()
    return planned
  }

  function gone(): boolean {
    return !existsSync(join(root, ...SETTINGS.split('/')))
  }

  it("deletes a settings.json that holds nothing but dogear's", () => {
    run()

    expect(undo()?.change?.summary).toBe(`deleted ${SETTINGS}`)
    expect(gone()).toBe(true)
  })

  it('deletes the file init wrote under --no-hook', () => {
    run({ hook: false })

    expect(undo()?.change?.summary).toBe(`deleted ${SETTINGS}`)
    expect(gone()).toBe(true)
  })

  it('deletes the hook-only file every init before #76 wrote', () => {
    seed(hookOnly())

    expect(undo()?.change?.summary).toBe(`deleted ${SETTINGS}`)
    expect(gone()).toBe(true)
  })

  it("leaves someone else's UserPromptSubmit entry, byte for byte", () => {
    // #39's third criterion, on the file where getting it wrong is worst: a splice one element
    // out silently deletes a hook the user depends on.
    const before =
      '{\n  "hooks": {\n    "UserPromptSubmit": [\n      {\n' +
      '        "hooks": [{ "type": "command", "command": "bash \\"chime.sh\\"" }]\n' +
      '      }\n    ]\n  }\n}\n'
    seed(before)
    run()

    expect(undo()?.change?.summary).toBe(
      "removed the prompt hook and dogear's MCP tool permissions from .claude/settings.json",
    )
    expect(read()).toBe(before)
  })

  it("leaves someone else's allow rules, byte for byte", () => {
    const before = '{\n  "permissions": {\n    "allow": [\n      "Read"\n    ]\n  }\n}\n'
    seed(before)
    run({ hook: false })

    expect(undo()?.change?.summary).toBe(
      "removed dogear's MCP tool permissions from .claude/settings.json",
    )
    expect(read()).toBe(before)
  })

  it('removes only the exact rules init writes, and only from allow', () => {
    // A wildcard the user added and a tool they denied are their decisions, not init's residue.
    run({ hook: false })
    const parsed = JSON.parse(read()) as Settings
    seed(
      `${JSON.stringify(
        {
          permissions: {
            allow: [...(parsed.permissions?.allow ?? []), 'mcp__dogear__*'],
            deny: ['mcp__dogear__dogear_prune'],
          },
        },
        null,
        2,
      )}\n`,
    )

    undo()

    expect(JSON.parse(read()) as unknown).toEqual({
      permissions: { allow: ['mcp__dogear__*'], deny: ['mcp__dogear__dogear_prune'] },
    })
  })

  it('reports the hook alone when only the hook is there to remove', () => {
    seed(hookOnly().replace('{\n', '{\n  "model": "opus",\n'))

    expect(undo()?.change?.summary).toBe(
      'removed the prompt hook from .claude/settings.json',
    )
    expect(JSON.parse(read()) as unknown).toEqual({ model: 'opus' })
  })

  it('leaves other events alone', () => {
    const before = '{\n  "hooks": {\n    "Stop": [{ "type": "command" }]\n  }\n}\n'
    seed(before)
    run()

    undo()

    expect(read()).toBe(before)
  })

  it('removes a hand-added second copy as well as the first', () => {
    // Unreachable through init, which refuses to add a second — but a hand-edited file can
    // hold two, and an undo that left one behind leaves the residue #39 exists to remove.
    run()
    const doubled = read().replace(
      /"UserPromptSubmit": \[\n(\s+)(\{[\s\S]*?\n\1\})\n/,
      '"UserPromptSubmit": [\n$1$2,\n$1$2\n',
    )
    seed(doubled)
    expect(entries(read())).toHaveLength(2)

    undo()

    // Spliced rather than deleted — the doubled file is not byte-identical to what init writes,
    // so the whole-file rule does not apply and both entries come out one at a time. The empty
    // containers they leave go with them.
    expect(read()).not.toContain('dogear')
    expect(JSON.parse(read()) as unknown).toEqual({})
  })

  it('identifies dogear’s entry the same way the insert side does', () => {
    // A user who raised the timeout or moved the entry still has dogear's hook. `wired()` and
    // the removal are both derived from one `dogearIndex`, so they cannot drift apart — this
    // is the assertion that would fail if they did.
    seed(
      '{\n  "hooks": {\n    "UserPromptSubmit": [\n      { "hooks": [{ "type": "command", ' +
        '"command": "node", "args": ["node_modules/dogear-cli/dist/cli.js", "hook"], ' +
        '"timeout": 60 }] }\n    ]\n  }\n}\n',
    )

    undo()

    expect(read()).not.toContain('dogear-cli')
  })

  it('plans nothing when there is no settings.json', () => {
    expect(claudeSettingsRemoval.plan(root)).toBeUndefined()
  })

  it('plans nothing when dogear never wrote to this file', () => {
    seed(
      '{\n  "permissions": {\n    "allow": ["mcp__dogear__*"]\n  },\n' +
        '  "hooks": {\n    "Stop": []\n  }\n}\n',
    )

    expect(claudeSettingsRemoval.plan(root)).toBeUndefined()
  })

  it('leaves an unparseable settings.json alone and says what to remove', () => {
    // MCP is already gone by the time this runs, so the honest report is "the hook is still
    // there, here is what it looks like" rather than a failure.
    const broken = '{ "hooks": '
    seed(broken)

    const planned = undo()

    expect(planned?.change).toBeUndefined()
    expect(planned?.notes?.[0]).toContain('could not be parsed')
    expect(planned?.notes?.[0]).toContain('dogear-cli/dist/cli.js hook')
    expect(planned?.notes?.[0]).toContain('permissions.allow')
    expect(read()).toBe(broken)
  })

  // #75, for the reason ./mcp-config.test.ts gives: undo cannot know init chose web/, and a
  // comparison against the root's fresh file alone would splice this to `{}` instead.
  it('deletes a settings.json init wrote whole with the web/ path', () => {
    run({ entry: WEB })

    expect(undo()?.change?.summary).toBe(`deleted ${SETTINGS}`)
    expect(gone()).toBe(true)
  })
})
