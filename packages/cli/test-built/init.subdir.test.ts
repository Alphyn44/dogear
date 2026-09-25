import { execFile } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * #75, against the real binary: what `dogear init` commits in a repository whose only
 * `package.json` is in `web/` has to *run*, from the root, the way the agent runs it.
 *
 * The fast suite pins the strings init writes. That is exactly what let #75 through: every test
 * asserted `node_modules/dogear-cli/dist/cli.js`, the string was right, and in this layout it
 * named a file no install would ever create. So this suite executes the committed entries as
 * written (the hook with `${CLAUDE_PROJECT_DIR}` expanded, the MCP server's path from the root,
 * where the client spawns it), which is the issue's own fourth reproduction step.
 *
 * **Nothing is installed.** `web/node_modules/dogear-cli` is a junction to this package, the same
 * trick `test-browser/` uses to reach the workspace without a registry. Node resolves a module
 * through its real path, so the built `dist/` and its chunks load exactly as they would from an
 * install. H6's `test-packed/managers/` covers what a real install lays out; what this covers is
 * the path init chose, and it stays inside `verify`, where a pull request cannot skip it.
 *
 * Runs under vitest.built.config.ts because it needs `npm run build` first.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(PACKAGE_DIR, 'dist', 'cli.js')

/** Where the fixture's only package keeps the CLI. */
const LINK = ['web', 'node_modules', 'dogear-cli'] as const

interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** `node <script> ...args` in `cwd`, exec form, as every agent config init writes spawns it. */
function run(
  script: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly env?: NodeJS.ProcessEnv
    readonly stdin?: string
  },
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [script, ...args],
      { cwd: options.cwd, env: options.env ?? process.env, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error(`node ${script} did not terminate: ${error.message}`))
          return
        }

        const exitCode =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ stdout, stderr, exitCode })
      },
    )

    child.stdin?.end(options.stdin ?? '')
  })
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-init-subdir-'))
  mkdirSync(join(root, '.git'))
  // The issue's reproduction had Claude Code in use, which is what earns the prompt hook.
  mkdirSync(join(root, '.claude'))

  mkdirSync(join(root, 'web', 'node_modules'), { recursive: true })
  writeFileSync(
    join(root, 'web', 'package.json'),
    JSON.stringify({ devDependencies: { 'dogear-cli': '^0.1.0', vite: '^8.2.1' } }),
  )
  writeFileSync(join(root, 'web', 'vite.config.ts'), '')

  // `'junction'` is ignored off Windows, where it makes an ordinary symlink; on Windows it is
  // what works without elevation.
  symlinkSync(PACKAGE_DIR, join(root, ...LINK), 'junction')
})

afterEach(() => {
  // The link goes **before** the tree, for the reason test-browser/fixture.ts's
  // `discardFixture` gives: a recursive delete must never be pointed at a live handle on this
  // package. Windows removes a junction with `rmdir` and POSIX a symlink with `unlink`.
  const link = join(root, ...LINK)

  if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
    try {
      unlinkSync(link)
    } catch {
      rmdirSync(link)
    }
  }

  rmSync(root, { recursive: true, force: true })
})

/** Run the built `dogear init` at the repository root and require it to succeed. */
async function init(): Promise<Run> {
  const result = await run(CLI, ['init'], { cwd: root })
  expect(result.exitCode, result.stderr).toBe(0)
  return result
}

function readJson(...path: string[]): unknown {
  return JSON.parse(readFileSync(join(root, ...path), 'utf8'))
}

interface HookSettings {
  readonly hooks: {
    readonly UserPromptSubmit: readonly {
      readonly hooks: readonly { readonly args: readonly string[] }[]
    }[]
  }
}

interface McpConfig {
  readonly mcpServers: { readonly dogear: { readonly args: readonly string[] } }
}

describe('dogear init in a repository whose only package.json is in web/ (#75)', () => {
  it('commits a prompt hook that runs, from the root, without an error', async () => {
    await init()

    const settings = readJson('.claude', 'settings.json') as HookSettings
    const [path, command] = settings.hooks.UserPromptSubmit[0]?.hooks[0]?.args ?? []

    // Expanded by hand exactly as Claude Code expands it.
    const script = (path ?? '').replace('${CLAUDE_PROJECT_DIR}', root)
    const result = await run(script, [command ?? ''], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
    })

    expect(result.stderr).not.toContain('MODULE_NOT_FOUND')
    expect(result.exitCode).toBe(0)
    // Nothing pending, so the hook's whole contract is silence: A4's zero bytes.
    expect(result.stdout).toBe('')
  })

  it('commits an MCP registration whose path runs from the root', async () => {
    await init()

    const [path] = (readJson('.mcp.json') as McpConfig).mcpServers.dogear.args

    // `--help` rather than `mcp`, as H6 does: spawning the path is the question, and a server
    // would then wait on stdin. Existence alone is not enough either, because cli.js imports a
    // chunk on its first line and only running it proves the whole graph resolves.
    const result = await run(path ?? '', ['--help'], { cwd: root })

    expect(result.stderr).not.toContain('MODULE_NOT_FOUND')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('init')
  })

  it('would have failed on the path init used to write, so the two above can fail', async () => {
    // The standing rule from check-leak.test.ts: a guard that cannot go red has not passed, it
    // has failed to run. In this fixture the root's path must not resolve, or the cases above
    // would pass on a revert to it.
    const result = await run('node_modules/dogear-cli/dist/cli.js', ['--help'], {
      cwd: root,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('MODULE_NOT_FOUND')
  })
})
