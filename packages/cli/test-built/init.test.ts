import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { QUEUE_DIR } from '@dogear/queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * E1's first acceptance criterion — `npm i -g @dogear/cli` puts `dogear` on PATH — checked as
 * far as it can be without publishing.
 *
 * `@dogear/cli` is still `private: true`; publishing is a release task with its own OIDC
 * workflow and no issue tracks it in M4. What a global install actually does, though, is a
 * short list, and all of it is observable here: npm reads `bin` from the manifest, symlinks
 * (or shims, on Windows) the named file onto PATH, and the OS runs it — which on POSIX means
 * the shebang has to be the first bytes of the file. This suite checks each of those, plus the
 * end that matters most: the binary, spawned as a subprocess with no workspace resolution
 * available to it, actually initializes a repository.
 *
 * The one thing left over is npm itself, and it is a manual smoke check recorded on #26:
 * `npm pack -w @dogear/cli` then `npm i -g ./dogear-cli-0.0.0.tgz`.
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
function runCli(command: string, cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, command],
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

  it('no longer advertises itself as unimplemented', async () => {
    // The usage footer is the first thing a new global install shows. Until E1 it named only
    // `hook`, `mcp` and `prune`, and a footer that lies about what is built is worse than no
    // footer at all.
    const help = await runCli('--help', root)

    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('`init`')
  })
})
