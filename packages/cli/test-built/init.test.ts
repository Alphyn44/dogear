import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { QUEUE_DIR } from 'dogear-queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * E1's first acceptance criterion — `npm i -g dogear-cli` puts `dogear` on PATH — checked as
 * far as it can be without publishing.
 *
 * Nothing here installs from the registry, and nothing should: a suite that reached npm would
 * test the network. What a global install actually does, though, is a
 * short list, and all of it is observable here: npm reads `bin` from the manifest, symlinks
 * (or shims, on Windows) the named file onto PATH, and the OS runs it — which on POSIX means
 * the shebang has to be the first bytes of the file. This suite checks each of those, plus the
 * end that matters most: the binary, spawned as a subprocess with no workspace resolution
 * available to it, actually initializes a repository.
 *
 * The one thing left over is npm itself, and it is a manual smoke check recorded on #26 and
 * since grown into G3 (#44): `npm pack -w dogear-cli`, then `npm i -g` the tarball it
 * writes.
 *
 * Runs under vitest.built.config.ts because it needs `npm run build` first.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(PACKAGE_DIR, 'dist', 'cli.js')

interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Spawn the built binary the way a PATH entry would: `node <path> <command>`, in `cwd`. */
function runCli(
  command: string,
  cwd: string,
  args: readonly string[] = [],
): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, command, ...args],
      { cwd, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error(`dogear ${command} did not terminate: ${error.message}`))
          return
        }

        const exitCode =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ stdout, stderr, exitCode })
      },
    )
  })
}

interface Manifest {
  readonly bin?: Record<string, string>
  readonly files?: readonly string[]
  readonly engines?: Record<string, string>
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as Manifest
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-init-built-'))
  mkdirSync(join(root, '.git'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('what a global install depends on', () => {
  it('exposes `dogear` in `bin`, pointing at a file that exists', () => {
    const bin = manifest().bin ?? {}

    expect(Object.keys(bin)).toEqual(['dogear'])
    expect(existsSync(resolvePath(PACKAGE_DIR, bin['dogear'] ?? ''))).toBe(true)
  })

  it('starts with a shebang, which is what makes the symlink executable', () => {
    // tsup preserves it from src/cli.ts. If a config change ever drops it, a global install
    // still "succeeds" and every invocation fails with a syntax error from the shell.
    expect(readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('ships dist/ in the published tarball', () => {
    // `files` is an allow-list. Without `dist`, npm packs the manifest and nothing else, and
    // `bin` points at a path the installed package does not contain.
    expect(manifest().files).toContain('dist')
  })

  it('declares the node floor, so a too-old global install fails at install time', () => {
    expect(manifest().engines?.['node']).toBe('^20.19.0 || >=22.12.0')
  })
})

describe('the built `dogear init`', () => {
  it('initializes a repository and reports what it created', async () => {
    const run = await runCli('init', root)

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain(`created ${QUEUE_DIR}/`)
    expect(existsSync(join(root, QUEUE_DIR))).toBe(true)
  })

  it('is idempotent across separate processes', async () => {
    // The single-process case is covered in ../src/scaffold.test.ts. This is the arrangement a
    // user has — two invocations sharing nothing but the filesystem — and it is the one that
    // would catch state cached in a module rather than read off disk.
    await runCli('init', root)
    const again = await runCli('init', root)

    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('nothing changed')
    expect(again.stdout).not.toContain('created')
  })

  it('does not append its .gitignore block twice when git cannot answer', async () => {
    // `.git` above is an empty directory, not a repository, so `git check-ignore` exits 128
    // and E4's gitignore step falls to its degraded path — which writes the rules rather than
    // assuming they are there. That makes this the only place the degraded path meets the real
    // binary, and the failure it guards is a `.gitignore` growing by three lines every run.
    await runCli('init', root)
    await runCli('init', root)

    const rules = readFileSync(join(root, '.gitignore'), 'utf8')

    expect(rules.match(new RegExp(`${QUEUE_DIR}/queue\\.json`, 'g'))).toHaveLength(1)
  })

  it('refuses outside a repository, on stderr, with a non-zero exit', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'dogear-init-bare-'))

    try {
      const run = await runCli('init', bare)

      expect(run.exitCode).toBe(1)
      expect(run.stdout).toBe('')
      expect(run.stderr).toContain('no git repository')
      expect(existsSync(join(bare, QUEUE_DIR))).toBe(false)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('prints the plugin snippet against a real Vite repo — E8 (#41)', async () => {
    // The other cases here run against a repo with no Vite config, so the block never appears
    // in them. It is the last thing the command prints and the only part the user is meant to
    // act on, which makes it worth one case through the real binary rather than only through
    // scaffold()'s return value.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.2.1' } }),
    )
    writeFileSync(join(root, 'vite.config.ts'), '')

    const run = await runCli('init', root)

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('add dogear to vite.config.ts:')
    expect(run.stdout).toContain("import { dogear } from 'dogear-vite'")
    expect(run.stdout).toContain('then, at the repo root: npm i -D dogear-vite')
    // Printed, never written. The manifest is exactly what the test wrote.
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({
      devDependencies: { vite: '^8.2.1' },
    })
  })

  it('honours --dry-run, which is the only path where argv survives the shim', async () => {
    // E2 (#27). Worth a built-binary case rather than only a unit one: everything below the
    // dispatcher is covered in ../src, and the thing this can break that those cannot is argv
    // itself — a flag dropped between the shim and `run()` produces a real init from a command
    // that promised not to write, and the report would still say `dry run`.
    const run = await runCli('init', root, ['--dry-run'])

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('dry run')
    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
  })

  it('refuses a mistyped flag rather than writing anyway', async () => {
    const run = await runCli('init', root, ['--dryrun'])

    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('--dryrun')
    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
  })

  it('wires the agent end to end, through the real binary — E3 (#28)', async () => {
    const run = await runCli('init', root)

    expect(run.exitCode).toBe(0)

    // The MCP registration is the baseline and the one thing that must always land.
    const registered = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: { dogear: { command: string; args: readonly string[] } }
    }
    expect(registered.mcpServers.dogear.command).toBe('node')
    expect(registered.mcpServers.dogear.args).toEqual([
      'node_modules/dogear-cli/dist/cli.js',
      'mcp',
    ])

    // MCP is pull, so the stanza is what makes it get pulled.
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('dogear_pending')

    // And the hook, written as `node <path>` because a global npm bin on Windows is a `.cmd`
    // shim the exec form cannot run. This is the assertion that would catch a "simplification"
    // to `command: "dogear"` — which passes every unit test and fails on one platform.
    const settings = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
    expect(settings).toContain('"command": "node"')
    expect(settings).toContain(
      '${CLAUDE_PROJECT_DIR}/node_modules/dogear-cli/dist/cli.js',
    )
    expect(settings).not.toContain('"command": "dogear"')
  })

  it('is idempotent across processes for the agent wiring too', async () => {
    // Separate from the general idempotency case above because these three steps read files
    // they also write — the shape most likely to grow a second copy of itself per run, which
    // is exactly what E4's gitignore step did before its `written()` guard.
    await runCli('init', root)
    const again = await runCli('init', root)

    expect(again.stdout).toContain('nothing changed')
    expect(
      readFileSync(join(root, 'AGENTS.md'), 'utf8').match(/<!-- dogear:start -->/g),
    ).toHaveLength(1)
  })

  it('merges into a settings.json that is already there, leaving it otherwise byte-identical', async () => {
    // The criterion in its own words: "existing hooks survive". Written hand-formatted, with a
    // one-line hook object, because that is the shape a re-serialising merge would silently
    // reflow — and reflowing the user's agent configuration is the failure this ticket's
    // whole approach exists to avoid.
    const before = [
      '{',
      '  "permissions": { "allow": ["Read"] },',
      '  "hooks": {',
      '    "UserPromptSubmit": [',
      '      { "hooks": [{ "type": "command", "command": "bash \\"mine.sh\\"" }] }',
      '    ]',
      '  }',
      '}',
      '',
    ].join('\n')
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude', 'settings.json'), before, 'utf8')

    const run = await runCli('init', root)

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('merged the prompt hook into .claude/settings.json')

    const after = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')

    expect(after).toContain('  "permissions": { "allow": ["Read"] },')
    expect(after).toContain(
      '      { "hooks": [{ "type": "command", "command": "bash \\"mine.sh\\"" }] },',
    )
    expect(
      (JSON.parse(after) as { hooks: { UserPromptSubmit: readonly unknown[] } }).hooks
        .UserPromptSubmit,
    ).toHaveLength(2)
  })

  it('leaves a working install when --no-hook declines the upgrade', async () => {
    const run = await runCli('init', root, ['--no-hook'])

    expect(run.exitCode).toBe(0)
    expect(existsSync(join(root, '.mcp.json'))).toBe(true)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(root, '.claude'))).toBe(false)
  })

  it('honours --agent through the shim, the same way --dry-run is honoured', async () => {
    const run = await runCli('init', root, ['--agent=cursor'])

    expect(run.exitCode).toBe(0)
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true)
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
  })

  it('writes no agent config at all under --dry-run', async () => {
    // E3's steps write outside `.dogear/` — into the user's agent configuration — which makes
    // this the case where the flag matters most.
    const run = await runCli('init', root, ['--dry-run'])

    expect(run.stdout).toContain('would register dogear in .mcp.json')
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(root, '.claude'))).toBe(false)
  })

  it('undoes itself end to end, through the real binary — E6 (#39)', async () => {
    // The whole point of the ticket, in the arrangement a user actually has: two separate
    // processes sharing nothing but the filesystem. Anything cached in a module rather than
    // read off disk fails here and nowhere in ../src.
    await runCli('init', root)
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(true)

    const run = await runCli('init', root, ['--undo'])

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('deleted .claude/settings.json')
    expect(run.stdout).toContain('deleted .mcp.json')
    expect(run.stdout).toContain('deleted AGENTS.md')

    // The hook is the residue that breaks something on every prompt. Nothing else on this list
    // does, which is why it comes out first — and why its absence is the assertion that matters.
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
  })

  it('reports nothing changed when undoing a repository that was never init’d', async () => {
    const run = await runCli('init', root, ['--undo'])

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('nothing changed')
  })

  it('honours --undo --dry-run through the shim', async () => {
    await runCli('init', root)

    const run = await runCli('init', root, ['--undo', '--dry-run'])

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('dry run')
    expect(run.stdout).toContain('would delete .mcp.json')
    expect(existsSync(join(root, '.mcp.json'))).toBe(true)
  })

  it('refuses --undo with --agent, on stderr, writing nothing', async () => {
    await runCli('init', root)

    const run = await runCli('init', root, ['--undo', '--agent=cursor'])

    expect(run.exitCode).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('--undo takes neither')
    expect(existsSync(join(root, '.mcp.json'))).toBe(true)
  })

  it('leaves a queue with pending annotations, and says why', async () => {
    // #39's fourth criterion. The queue is the user's data — removing it is a separate act,
    // not a side effect of removing dogear's configuration.
    await runCli('init', root)
    writeFileSync(
      join(root, QUEUE_DIR, 'queue.json'),
      `${JSON.stringify({
        version: 1,
        items: [{ id: 'x', comment: 'keep me', status: 'pending', createdAt: 'then' }],
      })}\n`,
    )

    const run = await runCli('init', root, ['--undo'])

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('1 pending annotation ')
    expect(existsSync(join(root, QUEUE_DIR, 'queue.json'))).toBe(true)
    expect(existsSync(join(root, QUEUE_DIR, 'config.json'))).toBe(false)
  })

  it('no longer advertises itself as unimplemented', async () => {
    // The usage footer is the first thing a new global install shows, and one that lies about
    // what is built is worse than no footer at all. Until E1 it named only `hook`, `mcp` and
    // `prune`; E5 (#30) built the last command and deleted the sentence entirely, so what is
    // asserted is the absence of any such claim rather than `init`'s presence in a list that
    // no longer exists. `init` is still checked to be documented — one line above this.
    const help = await runCli('--help', root)

    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('init')
    expect(help.stdout).not.toContain('are implemented')
    expect(help.stdout).not.toContain('not implemented')
  })
})
