import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * A4, against the real binary.
 *
 * `emit.test.ts` proves the *decision* — an empty queue produces an empty string. This
 * proves the claim the acceptance criterion actually makes: that the process Claude Code
 * spawns puts **zero bytes** on stdout and finishes well inside the timeout. Only a
 * subprocess sees the bundle, the shebang, and node's real startup cost, and those are
 * exactly where a stray byte or a slow import would come from.
 *
 * It runs under vitest.built.config.ts because it needs `npm run build` first, which is
 * why it cannot live in packages/cli/src alongside everything else.
 */

/** The registration writes this exact path. If it moves, the hook silently stops working. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js')

/**
 * The hook's registered timeout is 10s. Two seconds is ~12x the measured cost and 5x under
 * that ceiling: high enough that a contended CI runner will not trip it, low enough that
 * anything doing real work — a network call, a walk of the repo — fails loudly.
 */
const BUDGET_MS = 2_000

interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly durationMs: number
}

/**
 * Invoke the CLI the way Claude Code does: `node <path> hook`, with the event payload on
 * stdin and `CLAUDE_PROJECT_DIR` set. Exec form, no shell — matching the registration.
 */
function runHook(projectDir: string): Promise<Run> {
  const startedAt = performance.now()

  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI, 'hook'],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        // A non-zero exit arrives here as an error. That is a result, not a failure —
        // asserting on the exit code is most of the point.
        const exitCode =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0

        if (error && error.killed) {
          reject(new Error(`dogear hook did not terminate: ${error.message}`))
          return
        }

        resolve({
          stdout,
          stderr,
          exitCode,
          durationMs: performance.now() - startedAt,
        })
      },
    )

    // Claude Code writes the event payload to stdin. Closing it without writing would be a
    // different test than the one that matters.
    child.stdin?.end(
      JSON.stringify({
        session_id: 'a4-built-suite',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'go',
      }),
    )
  })
}

let projectDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dogear-built-'))
  mkdirSync(join(projectDir, '.git'))
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function writeQueue(items: readonly unknown[]): void {
  const dir = join(projectDir, '.dogear')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'queue.json'),
    `${JSON.stringify({ version: 1, updatedAt: null, items }, null, 2)}\n`,
  )
}

const PENDING = {
  id: '019fef13-1d76-7000-9fbf-91e24ad5889b',
  status: 'pending',
  comment: 'make this darker',
  element: { tag: 'button', selector: 'nav > button', text: 'Settings' },
}

describe('the built `dogear hook` binary', () => {
  it.each([
    { why: 'the queue file does not exist', setup: () => {} },
    { why: 'the queue is present but empty', setup: () => writeQueue([]) },
    {
      why: 'every item is already resolved',
      setup: () => writeQueue([{ ...PENDING, status: 'resolved' }]),
    },
  ])('writes zero bytes to stdout when $why', async ({ setup }) => {
    setup()

    const run = await runHook(projectDir)

    // Byte length, not a string comparison: this is a claim about what reaches the file
    // descriptor, and a blank line would satisfy a laxer assertion while still prepending
    // itself to every prompt the user types.
    expect(Buffer.byteLength(run.stdout)).toBe(0)
    expect(run.exitCode).toBe(0)
  })

  it('still emits context when the queue has something to say', async () => {
    // The counterweight. Without it, a binary that silently emitted nothing ever would
    // pass every other test in this file.
    writeQueue([PENDING])

    const run = await runHook(projectDir)

    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain(
      'make this darker',
    )
  })

  it.each([
    { why: 'an empty queue', setup: () => writeQueue([]) },
    { why: 'a populated queue', setup: () => writeQueue([PENDING, PENDING, PENDING]) },
  ])(`completes well inside the 10s hook timeout with $why`, async ({ setup }) => {
    setup()

    const run = await runHook(projectDir)

    expect(run.durationMs).toBeLessThan(BUDGET_MS)
  })

  it('exits 0 with empty stdout on a corrupt queue, reporting on stderr instead', async () => {
    // The one case where the binary has something to say and must not say it on stdout:
    // exit 0 keeps the prompt intact, and stderr on a zero exit reaches the debug log
    // rather than the model.
    mkdirSync(join(projectDir, '.dogear'), { recursive: true })
    writeFileSync(join(projectDir, '.dogear', 'queue.json'), '{"version":1,"items":[')

    const run = await runHook(projectDir)

    expect(run.exitCode).toBe(0)
    expect(Buffer.byteLength(run.stdout)).toBe(0)
    expect(run.stderr).toContain('dogear:')
  })
})
