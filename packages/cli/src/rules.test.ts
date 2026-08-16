import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Agent } from './detect.js'
import { createRulesStep } from './rules.js'
import type { Plan, Wiring } from './scaffold.js'
import { createRepo, NO_DETECTION, removeRepo } from './test-repo.js'

/**
 * The stanza that makes a pull-based MCP server actually get pulled — E3 (#28).
 *
 * The two properties worth pinning: it goes in the file the repository's agent already reads,
 * and it is a true append that leaves everything above it untouched.
 */

let root: string

beforeEach(() => {
  root = createRepo('dogear-rules-')
})

afterEach(() => {
  removeRepo(root)
})

function wiring(agents: readonly Agent[] = ['claude']): Wiring {
  return { agents, hook: true, cli: 'local' }
}

function plan(agents: readonly Agent[] = ['claude']): Plan | undefined {
  return createRulesStep(wiring(agents)).plan(root, NO_DETECTION)
}

function run(agents: readonly Agent[] = ['claude']): void {
  plan(agents)?.change?.apply()
}

function seed(file: string, contents: string): void {
  writeFileSync(join(root, file), contents, 'utf8')
}

function read(file: string): string {
  return readFileSync(join(root, file), 'utf8')
}

describe('createRulesStep() choosing where to write', () => {
  it('creates AGENTS.md when the repository has no rules file', () => {
    expect(plan()?.change?.summary).toBe('created AGENTS.md')

    run()

    expect(read('AGENTS.md')).toContain('<!-- dogear:start -->')
  })

  it('appends to CLAUDE.md when that is what exists', () => {
    seed('CLAUDE.md', '# House rules\n')

    expect(plan()?.change?.summary).toBe("added dogear's stanza to CLAUDE.md")

    run()

    expect(read('CLAUDE.md')).toContain('# House rules')
    expect(read('CLAUDE.md')).toContain('<!-- dogear:start -->')
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
  })

  it('prefers AGENTS.md when both exist', () => {
    seed('AGENTS.md', '# Agents\n')
    seed('CLAUDE.md', '# Claude\n')

    run()

    expect(read('AGENTS.md')).toContain('<!-- dogear:start -->')
    expect(read('CLAUDE.md')).toBe('# Claude\n')
  })

  it('writes nothing when no agent was selected', () => {
    expect(plan([])).toBeUndefined()
  })
})

describe('createRulesStep() appending', () => {
  const cases: readonly { readonly name: string; readonly before: string }[] = [
    { name: 'a file ending in one newline', before: '# Rules\n' },
    { name: 'a file ending in two newlines', before: '# Rules\n\n' },
    { name: 'a file with no trailing newline', before: '# Rules' },
    { name: 'an empty file', before: '' },
  ]

  it.each(cases)('leaves $name intact above the stanza', ({ before }) => {
    seed('AGENTS.md', before)

    run()

    const after = read('AGENTS.md')

    expect(after.startsWith(before)).toBe(true)
    expect(after).toContain('<!-- dogear:start -->')
    // The user's last line is never merged into the opening marker.
    expect(after).not.toContain('Rules<!-- dogear')
  })

  it('names both MCP tools, since the stanza exists to get them called', () => {
    run()

    const after = read('AGENTS.md')

    expect(after).toContain('dogear_pending')
    expect(after).toContain('dogear_resolve')
  })
})

describe('createRulesStep() re-running', () => {
  it('is a no-op once the stanza is there', () => {
    run()
    const after = read('AGENTS.md')

    expect(plan()).toBeUndefined()
    expect(after).toBe(read('AGENTS.md'))
  })

  it('does not append a second copy when the prose between the markers was edited', () => {
    seed('AGENTS.md', '<!-- dogear:start -->\nmy own words\n<!-- dogear:end -->\n')

    expect(plan()).toBeUndefined()
  })

  it('does not append a second copy when the end marker was deleted', () => {
    seed('AGENTS.md', '<!-- dogear:start -->\nleftovers\n')

    expect(plan()).toBeUndefined()
  })

  it('does not write twice when the stanza arrived between plan and apply', () => {
    const planned = plan()
    seed('AGENTS.md', '<!-- dogear:start -->\nsomeone else did it\n<!-- dogear:end -->\n')

    planned?.change?.apply()

    expect(read('AGENTS.md')).toBe(
      '<!-- dogear:start -->\nsomeone else did it\n<!-- dogear:end -->\n',
    )
  })
})
