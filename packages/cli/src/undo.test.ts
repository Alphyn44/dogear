import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { QUEUE_DIR, queuePathFor, registryKey, registryPath } from 'dogear-queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scaffold, unscaffold } from './scaffold.js'
import { createRepo, isolateGitConfig, isolateRegistry, removeRepo } from './test-repo.js'

/**
 * What `dogear init --undo` takes back out, and what it refuses to — E6 (#39).
 *
 * ./scaffold.test.ts is this file's twin and covers the way in. The suites either side of it
 * cover a step at a time; what is asserted here is the **runner** — ordering, the report, and
 * the whole-repository properties no single step can state.
 *
 * **The round trip is the point of the file.** #39's third acceptance criterion is that entries
 * dogear did not write survive, and the honest way to assert that is not to enumerate the ways
 * a splice could go wrong — it is to photograph the repository, wire it, unwire it, and demand
 * the photograph back. Every case-by-case assertion below is a diagnostic for when that one
 * fails; the property is what actually holds the ticket.
 *
 * **`isolateRegistry()` is not optional**, and neither is the failure it prevents visible: the
 * last step writes outside the repository, so without it every case here would leave entries
 * for deleted temp directories in the developer's own `~/.dogear/projects.json`. See
 * ./test-repo.ts.
 */

let root: string
let restoreGitConfig: () => void
let registry: ReturnType<typeof isolateRegistry>

beforeEach(() => {
  restoreGitConfig = isolateGitConfig()
  registry = isolateRegistry()
  root = createRepo('dogear-undo-')
})

afterEach(() => {
  registry.restore()
  restoreGitConfig()
  removeRepo(root)
})

/**
 * Every file in the repository, keyed by its path — `.git` excluded, since git rewrites its own
 * innards on every command and none of it is dogear's business.
 */
function snapshot(dir: string = root): Map<string, string> {
  const files = new Map<string, string>()

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue

    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      for (const [key, value] of snapshot(path)) files.set(key, value)
      continue
    }

    files.set(relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'))
  }

  return files
}

/** A repository with something of the user's in every file init is going to touch. */
function seedLivedInRepo(): void {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        devDependencies: { vite: '^8.2.1', 'dogear-cli': '^0.1.0' },
        dependencies: { react: '^19.2.0' },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(root, 'vite.config.ts'), '')
  writeFileSync(join(root, '.gitignore'), 'node_modules\ndist\n')
  writeFileSync(join(root, 'AGENTS.md'), '# My repo\n\nRead the docs first.\n')

  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    [
      '{',
      '  "permissions": {',
      '    "allow": ["Read", "Glob"]',
      '  },',
      '  "hooks": {',
      '    "UserPromptSubmit": [',
      '      {',
      '        "hooks": [{ "type": "command", "command": "bash \\"chime.sh\\"" }]',
      '      }',
      '    ]',
      '  }',
      '}',
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(root, '.mcp.json'),
    '{\n  "mcpServers": {\n    "other": { "command": "node" }\n  }\n}\n',
  )
}

function settings(): string {
  return readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
}

describe('undoing an init on a repository that has one', () => {
  it('gives back every byte it was handed', () => {
    // The criterion, stated as a property rather than a list of cases. A splice that is a
    // newline out, an indent that gets rebuilt, a separator that is not put back — all of it
    // shows up here and nowhere else.
    seedLivedInRepo()
    const before = snapshot()

    scaffold(root)
    expect(snapshot()).not.toEqual(before)

    unscaffold(root)

    expect(snapshot()).toEqual(before)
  })

  it('reports each thing it removed', () => {
    seedLivedInRepo()
    scaffold(root)

    const { output, exitCode } = unscaffold(root)

    expect(exitCode).toBe(0)
    expect(output).toContain('removed the prompt hook from .claude/settings.json')
    expect(output).toContain('removed dogear from .mcp.json')
    expect(output).toContain("removed dogear's stanza from AGENTS.md")
    expect(output).toContain("removed dogear's rules from .gitignore")
    expect(output).toContain(`deleted ${QUEUE_DIR}/config.json`)
    expect(output).toContain(`deleted ${QUEUE_DIR}/`)
    expect(output).toContain('removed this repository from')
  })

  it('takes the prompt hook out first, before anything that could fail', () => {
    // #39's second criterion, and the reason this is a command rather than a README paragraph:
    // an orphaned UserPromptSubmit entry is the only residue that breaks something on every
    // prompt. `applyAll` stops at the first failure, so its position in the report is its
    // position in the run.
    seedLivedInRepo()
    scaffold(root)

    const lines = unscaffold(root).output.split('\n')
    const hook = lines.findIndex((line) => line.includes('.claude/settings.json'))

    expect(hook).toBeGreaterThan(-1)
    for (const other of ['.mcp.json', 'AGENTS.md', '.gitignore', 'config.json']) {
      expect(lines.findIndex((line) => line.includes(other))).toBeGreaterThan(hook)
    }
  })

  it('reports nothing changed when run a second time', () => {
    seedLivedInRepo()
    scaffold(root)
    unscaffold(root)

    const second = unscaffold(root)

    expect(second.exitCode).toBe(0)
    expect(second.output).toContain('nothing changed')
  })

  it('says nothing about vite, the framework, or the plugin install', () => {
    // Detection is skipped entirely. All of it — the findings block, the JSX-only remark, E8's
    // install snippet — describes a repository being set up, and printing it above a teardown
    // would be telling the user what to install while removing it.
    seedLivedInRepo()
    scaffold(root)

    const { output } = unscaffold(root)

    expect(output).not.toContain('vite:')
    expect(output).not.toContain('framework:')
    expect(output).not.toContain('agent:')
    expect(output).not.toContain('npm i -D dogear-vite')
  })
})

describe('undoing an init that was never run', () => {
  it('reports nothing changed and exits 0', () => {
    // Falls straight out of `plan()` returning `undefined` — the same mechanism that makes
    // re-running init a no-op, doing its second job.
    const { output, exitCode } = unscaffold(root)

    expect(exitCode).toBe(0)
    expect(output).toContain('nothing changed')
  })

  it('writes nothing at all', () => {
    const before = snapshot()

    unscaffold(root)

    expect(snapshot()).toEqual(before)
  })
})

describe('undoing under --dry-run', () => {
  it('reports what it would remove, in the imperative', () => {
    seedLivedInRepo()
    scaffold(root)

    const { output } = unscaffold(root, { dryRun: true })

    expect(output).toContain('dry run — nothing was written')
    expect(output).toContain('would remove the prompt hook from .claude/settings.json')
    expect(output).toContain(`would delete ${QUEUE_DIR}/config.json`)
    // The verb table is what stands between this and `would removed`, which is why every
    // teardown verb has an entry — see ./scaffold.test.ts.
    expect(output).not.toMatch(/would (removed|deleted)/)
  })

  it('changes not one byte', () => {
    seedLivedInRepo()
    scaffold(root)
    const wired = snapshot()

    unscaffold(root, { dryRun: true })

    expect(snapshot()).toEqual(wired)
  })
})

describe('what undo must not touch', () => {
  it("leaves someone else's UserPromptSubmit hook exactly where it was", () => {
    seedLivedInRepo()
    scaffold(root)
    unscaffold(root)

    expect(settings()).toContain(
      '        "hooks": [{ "type": "command", "command": "bash \\"chime.sh\\"" }]',
    )
    expect(settings()).toContain('    "allow": ["Read", "Glob"]')
    expect(settings()).not.toContain('dogear')
  })

  it('leaves other MCP servers registered', () => {
    seedLivedInRepo()
    scaffold(root)
    unscaffold(root)

    const parsed = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }

    expect(parsed.mcpServers).toHaveProperty('other')
    expect(parsed.mcpServers).not.toHaveProperty('dogear')
  })

  it("leaves the user's own gitignore rules", () => {
    seedLivedInRepo()
    scaffold(root)
    unscaffold(root)

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\ndist\n')
  })

  it('leaves prose the user wrote around the stanza', () => {
    seedLivedInRepo()
    scaffold(root)
    unscaffold(root)

    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(
      '# My repo\n\nRead the docs first.\n',
    )
  })
})

describe('a queue with pending annotations', () => {
  /** A queue holding one pending item, as the plugin would have written it. */
  function seedQueue(): void {
    mkdirSync(join(root, QUEUE_DIR), { recursive: true })
    writeFileSync(
      queuePathFor(root),
      `${JSON.stringify({
        version: 1,
        items: [
          {
            id: '019ffb9d-23fd-7000-8b54-703b662b90db',
            comment: 'do not delete me',
            status: 'pending',
            createdAt: '2026-08-19T00:00:00.000Z',
          },
        ],
      })}\n`,
    )
  }

  it('is not deleted', () => {
    // #39's fourth criterion. The queue is the user's data, and the whole append-with-status
    // design exists so that nothing throws it away silently.
    seedLivedInRepo()
    scaffold(root)
    seedQueue()
    const queue = readFileSync(queuePathFor(root), 'utf8')

    unscaffold(root)

    expect(existsSync(queuePathFor(root))).toBe(true)
    expect(readFileSync(queuePathFor(root), 'utf8')).toBe(queue)
  })

  it('keeps .dogear/ and says why, with the count', () => {
    seedLivedInRepo()
    scaffold(root)
    seedQueue()

    const { output } = unscaffold(root)

    expect(existsSync(join(root, QUEUE_DIR))).toBe(true)
    expect(output).toContain('1 pending annotation ')
    expect(output).toContain('the queue is your data')
    // The whole line, not the prefix: `deleted .dogear/config.json` is on this report and
    // starts with the same bytes.
    expect(output.split('\n').map((line) => line.trim())).not.toContain(
      `deleted ${QUEUE_DIR}/`,
    )
  })

  it('still removes the config beside it', () => {
    // The directory staying must not become an excuse for leaving dogear's own file in it.
    seedLivedInRepo()
    scaffold(root)
    seedQueue()

    unscaffold(root)

    expect(existsSync(join(root, QUEUE_DIR, 'config.json'))).toBe(false)
  })
})

describe('the machine-level registry', () => {
  function projects(): Record<string, unknown> {
    const raw = readFileSync(registryPath({ DOGEAR_HOME: registry.home }), 'utf8')
    return (JSON.parse(raw) as { projects: Record<string, unknown> }).projects
  }

  it('loses this repository entirely', () => {
    seedLivedInRepo()
    scaffold(root)
    expect(projects()).toHaveProperty(registryKey(root))

    unscaffold(root)

    expect(projects()).not.toHaveProperty(registryKey(root))
  })

  it("leaves other repositories' entries alone", () => {
    const other = createRepo('dogear-undo-other-')
    try {
      scaffold(other)
      seedLivedInRepo()
      scaffold(root)

      unscaffold(root)

      expect(projects()).toHaveProperty(registryKey(other))
      expect(projects()).not.toHaveProperty(registryKey(root))
    } finally {
      removeRepo(other)
    }
  })
})
