import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QUEUE_DIR } from '@dogear/queue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { init } from './init.js'
import { isAsync } from './run.js'

/**
 * The command adapter, not the scaffolding — E1 (#26).
 *
 * ./scaffold.test.ts covers what init does to a repository and what it says about it.
 * Everything here is about the two decisions `init()` makes before any of that — which
 * repository, and whether there is one at all — plus the one thing only this file can see:
 * that the continuation puts its bytes on stdout through `write()` rather than returning them.
 * Structurally the twin of ./mcp.test.ts, because the adapters are twins.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-init-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * Run the continuation with stdout captured.
 *
 * Captured rather than merely silenced: `dogear init` is the first command in this package
 * whose bytes are written from somewhere other than ./cli.ts, and the whole reason `write()`
 * is shared is that a second copy of that logic would break the empty-string rule in one place
 * and not the other. Asserting the stream here is what makes the sharing checkable.
 */
async function runCapturing(
  outcome: ReturnType<typeof init>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!isAsync(outcome)) throw new Error('expected an asynchronous outcome')

  let stdout = ''
  let stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })

  const exitCode = await outcome.run()
  return { exitCode, stdout, stderr }
}

describe('init()', () => {
  it('hands back an asynchronous outcome inside a repository', () => {
    mkdirSync(join(root, '.git'))

    expect(isAsync(init(root))).toBe(true)
  })

  it('walks up to the git root, so init in a subdirectory sets up the whole repo', async () => {
    // The queue is one file per repository, so `dogear init` run inside `packages/admin` has
    // to scaffold the root — not the package. Getting this wrong would produce a `.dogear/`
    // the dev server and the MCP server both walk straight past.
    mkdirSync(join(root, '.git'))
    const nested = join(root, 'packages', 'apps', 'admin')
    mkdirSync(nested, { recursive: true })

    const { exitCode } = await runCapturing(init(nested))

    expect(exitCode).toBe(0)
    expect(existsSync(join(root, QUEUE_DIR))).toBe(true)
    expect(existsSync(join(nested, QUEUE_DIR))).toBe(false)
  })

  it('writes the report to STDOUT and exits 0', async () => {
    mkdirSync(join(root, '.git'))

    const { exitCode, stdout, stderr } = await runCapturing(init(root))

    expect(exitCode).toBe(0)
    expect(stdout).toContain(`created ${QUEUE_DIR}/`)
    expect(stdout.endsWith('\n')).toBe(true)
    expect(stderr).toBe('')
  })

  it('sends a FAILING report to stderr instead, as emit() routes it', async () => {
    // Not a special case in init.ts — `write()` routes a non-zero exit to stderr for every
    // command. Asserted here because init is the first caller of `write()` outside ./cli.ts,
    // and a shell pipeline reading `dogear init` deserves the same contract as `dogear prune`.
    mkdirSync(join(root, '.git'))
    // `.dogear` already there as a regular file, so the directory step throws.
    writeFileSync(join(root, QUEUE_DIR), 'not a directory')

    const { exitCode, stdout, stderr } = await runCapturing(init(root))

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('failed')
  })

  it('REFUSES outside a repository, and says why rather than guessing cwd', () => {
    // #26's second acceptance criterion. Falling back to cwd would be the tempting fix and is
    // the worst available outcome: init would succeed, and the queue would sit somewhere no
    // other reader in the system walks to — an install that looks fine and is permanently
    // empty. Refusing is the only honest answer.
    const outcome = init(root)

    expect(isAsync(outcome)).toBe(false)
    if (isAsync(outcome)) return

    expect(outcome.exitCode).toBe(1)
    expect(outcome.output).toContain(root)
    expect(outcome.output).toContain('no git repository')
    // Names the reason, not just the fault. The message has to be actionable to someone who
    // does not know the queue lives at the git root.
    expect(outcome.output).toContain(QUEUE_DIR)
  })

  it('changes nothing on the way out when it refuses', () => {
    init(root)

    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
  })

  it('passes --dry-run through, so the repository is untouched', async () => {
    mkdirSync(join(root, '.git'))

    const { exitCode, stdout } = await runCapturing(init(root, ['--dry-run']))

    expect(exitCode).toBe(0)
    expect(stdout).toContain('dry run')
    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
  })

  it('REFUSES an unrecognised argument rather than ignoring it', () => {
    // The asymmetry that decides this: ignoring `--dryrun` writes to a repository whose owner
    // has just asked it not to, while over-strictness costs a re-typed command. A flag whose
    // entire purpose is "change nothing" is the worst possible one to silently drop.
    mkdirSync(join(root, '.git'))
    const outcome = init(root, ['--dryrun'])

    expect(isAsync(outcome)).toBe(false)
    if (isAsync(outcome)) return

    expect(outcome.exitCode).toBe(1)
    expect(outcome.output).toContain('--dryrun')
    expect(outcome.output).toContain('--dry-run')
  })

  it('changes nothing when it refuses a bad flag', () => {
    mkdirSync(join(root, '.git'))
    init(root, ['--dryrun'])

    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
  })

  it('checks the flags BEFORE the repository, so a typo is reported as a typo', () => {
    // No `.git` here. Both things are wrong, and the one the user can fix by retyping is the
    // one worth naming — reporting the missing repository would send them looking for the
    // wrong problem.
    const outcome = init(root, ['--dryrun'])

    expect(isAsync(outcome)).toBe(false)
    if (isAsync(outcome)) return

    expect(outcome.output).toContain('--dryrun')
    expect(outcome.output).not.toContain('no git repository')
  })

  it('decides without doing anything — run() is a continuation, not a side effect', () => {
    // Constructing the outcome must not touch the filesystem or load ./scaffold.js. The
    // laziness is what keeps `dogear hook` off this code path entirely; ../test-built's 2s
    // budget is the alarm if that regresses.
    mkdirSync(join(root, '.git'))
    const outcome = init(root)

    expect(isAsync(outcome) && typeof outcome.run).toBe('function')
    expect(existsSync(join(root, QUEUE_DIR))).toBe(false)
  })
})
