import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Annotation } from 'dogear-queue'
import { appendToQueue, queuePathFor, stampAnnotation } from 'dogear-queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The two binaries agree about one queue file — D2 (#21).
 *
 * ../src/agreement.test.ts makes this claim in a single process, which proves the file
 * contract but not much else: both halves import the same `dogear-queue` module instance,
 * so a bug that lived in shared state rather than on disk would go unnoticed.
 *
 * Here `dogear mcp` and `dogear hook` are genuinely separate processes that never speak to
 * each other. The server resolves an item and exits; the hook is spawned afterwards, reads
 * the file cold, and must already agree. That is the arrangement a user actually has — an
 * MCP server registered in their editor and a hook fired on every prompt — and the file is
 * the only thing joining them.
 *
 * Needs `npm run build` first; runs under vitest.built.config.ts.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-agreement-built-'))
  mkdirSync(join(root, '.git'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Seed through the endpoint's own path, so items carry the shape the plugin writes. */
function seed(...comments: readonly string[]): readonly Annotation[] {
  const annotations = comments.map((comment) =>
    stampAnnotation({
      comment,
      sites: [
        { file: 'src/App.tsx', line: 12, column: 5, tag: 'button', via: 'attribute' },
      ],
      element: { tag: 'button', selector: 'nav > button', text: 'Settings' },
    }),
  )

  appendToQueue(queuePathFor(root), annotations)
  return annotations
}

/** Resolve ids through a real MCP session against the built server, then disconnect. */
async function resolveOverMcp(ids: readonly string[]): Promise<unknown> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: root,
    stderr: 'pipe',
  })

  const client = new Client({ name: 'dogear-agreement-suite', version: '0.0.0' })
  await client.connect(transport)

  try {
    const result = await client.callTool({ name: 'dogear_resolve', arguments: { ids } })
    return result.structuredContent
  } finally {
    // Closed before the hook runs. The point is that nothing of this session survives —
    // the hook gets no handoff, only the file.
    await client.close()
  }
}

interface HookRun {
  readonly stdout: string
  readonly exitCode: number
}

/** Invoke the built hook exactly as Claude Code does: `node <path> hook`, event on stdin. */
function runHook(): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI, 'hook'],
      { env: { ...process.env, CLAUDE_PROJECT_DIR: root }, timeout: 30_000 },
      (error, stdout) => {
        if (error && error.killed) {
          reject(new Error(`dogear hook did not terminate: ${error.message}`))
          return
        }

        const exitCode =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ stdout, exitCode })
      },
    )

    child.stdin?.end(
      JSON.stringify({
        session_id: 'd2-agreement',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'go',
      }),
    )
  })
}

/** What the built hook would inject — `undefined` when it writes nothing at all. */
function contextOf(run: HookRun): string | undefined {
  expect(run.exitCode).toBe(0)
  if (Buffer.byteLength(run.stdout) === 0) return undefined

  const envelope = JSON.parse(run.stdout) as {
    hookSpecificOutput: { additionalContext: string }
  }
  return envelope.hookSpecificOutput.additionalContext
}

describe('the built `dogear mcp` and `dogear hook`, over one queue file', () => {
  it('BOTH surfaces see a freshly written annotation', async () => {
    // The control. Every disappearance below would also "pass" against a hook that had
    // stopped emitting anything at all.
    seed('make this darker')

    expect(contextOf(await runHook())).toContain('make this darker')
  })

  it('an item resolved by the SERVER is gone from the next HOOK invocation', async () => {
    // D2's second criterion at full strength: two processes, no shared memory, one file.
    const [first] = seed('already handled', 'still open')

    expect(await resolveOverMcp([first!.id])).toEqual({ resolved: 1, remaining: 1 })

    const context = contextOf(await runHook())
    expect(context).not.toContain('already handled')
    expect(context).toContain('still open')
    expect(context).toContain('count="1"')
  })

  it('writes zero bytes once the server has resolved the last item', async () => {
    // A4's rule surviving a cross-process resolve. Byte length, not a string comparison:
    // UserPromptSubmit injects stdout verbatim, so a stray newline is a stray newline in
    // front of every prompt the user types.
    const [only] = seed('the only one')

    await resolveOverMcp([only!.id])

    expect(Buffer.byteLength((await runHook()).stdout)).toBe(0)
  })

  it('an UNKNOWN id resolved by the server leaves the hook output identical', async () => {
    seed('untouched')
    const before = (await runHook()).stdout

    expect(await resolveOverMcp(['no-such-id'])).toEqual({ resolved: 0, remaining: 1 })

    expect((await runHook()).stdout).toBe(before)
  })
})
