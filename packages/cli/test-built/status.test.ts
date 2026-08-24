import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerProject, registerServer, registryPath } from 'dogear-queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * E5's (#30) second acceptance criterion — `dogear status` works from anywhere, not just
 * inside a repository.
 *
 * **This is the one claim no unit test can make.** ../src/status.test.ts drives `status(env,
 * cwd)` with a `cwd` outside any repository, which covers the branch; it cannot show that the
 * *command* does not refuse, because refusing is something `run()` and the process do. Every
 * other command in this CLI opens by walking up for `.git` and exiting non-zero when there is
 * none, so "does not refuse" is a property of the whole binary and has to be spawned to be
 * seen.
 *
 * Getting a working directory that is genuinely outside a repository takes some care: the
 * repo this suite runs from is one, and so is anything under it. A fresh temp directory is
 * used, and asserted not to be inside a repository before anything else is claimed about it.
 *
 * Runs under vitest.built.config.ts because it needs `npm run build` first.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js')

interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

let home: string
let outside: string
let path: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dogear-built-home-'))
  outside = mkdtempSync(join(tmpdir(), 'dogear-built-outside-'))
  path = registryPath({ DOGEAR_HOME: home })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/**
 * Spawn the built binary with the registry pointed somewhere disposable.
 *
 * `DOGEAR_HOME` is passed explicitly rather than inherited: ../../../vitest.setup.ts sets one
 * for this process, and a subprocess sharing it would read a registry the other suites are
 * writing to.
 */
function runCli(cwd: string, args: readonly string[] = []): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, 'status', ...args],
      { cwd, timeout: 30_000, env: { ...process.env, DOGEAR_HOME: home } },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error(`dogear status did not terminate: ${error.message}`))
          return
        }

        const exitCode =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ stdout, stderr, exitCode })
      },
    )
  })
}

describe('dogear status, spawned as the built binary', () => {
  it('runs outside a git repository instead of refusing', async () => {
    // The premise, checked rather than assumed: every other command would exit 1 here.
    const init = await new Promise<number>((resolve) => {
      execFile(
        process.execPath,
        [CLI, 'prune'],
        { cwd: outside, timeout: 30_000 },
        (error) => resolve(error ? 1 : 0),
      )
    })
    expect(init).toBe(1)

    const result = await runCli(outside)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('no repositories registered')
  })

  it('lists a registered repository from outside every repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dogear-built-repo-'))
    writeFileSync(join(repo, '.git'), 'gitdir: /elsewhere')

    try {
      registerProject(path, repo)
      registerServer(path, repo, {
        origin: 'http://localhost:5173',
        pid: process.pid,
        app: 'react-app',
      })

      const result = await runCli(outside)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(repo)
      expect(result.stdout).toContain('http://localhost:5173')
      expect(result.stdout).toContain('1 dev server running')
      // Nothing marked, because the working directory is in no repository at all.
      expect(result.stdout).not.toContain('(this repo)')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('marks the current repository when run inside one', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dogear-built-here-'))
    writeFileSync(join(repo, '.git'), 'gitdir: /elsewhere')

    try {
      registerProject(path, repo)

      expect((await runCli(repo)).stdout).toContain('(this repo)')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('exits non-zero with a message on stderr when the registry will not parse', async () => {
    writeFileSync(path, '{ nope')

    const result = await runCli(outside)

    // `emit()` routes a non-zero exit's output to stderr, so a shell pipeline sees the failure
    // where it expects to.
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('could not be read')
  })

  it('is listed as a real command by `dogear --help`', async () => {
    const help = await new Promise<string>((resolve) => {
      execFile(
        process.execPath,
        [CLI, '--help'],
        { cwd: outside, timeout: 30_000 },
        (_error, stdout) => resolve(stdout),
      )
    })

    expect(help).toContain('status')
    // The footer that used to say only some commands were built is gone, now that none are.
    expect(help).not.toContain('are implemented')
  })
})
