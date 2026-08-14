import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * D1, against the real binary and a real MCP client.
 *
 * ../src/tools.test.ts proves everything dogear *does*, without a transport. This file
 * proves the two things only a spawned process can show:
 *
 * 1. **The handshake works.** Driven with the SDK's own `Client`, which is as close to
 *    "another MCP client" as a test can get — it performs the real `initialize` exchange,
 *    so a capability or protocol-version mistake fails here rather than in someone's editor.
 * 2. **stdout carries nothing but protocol frames.** stdio MCP shares the file descriptor,
 *    so one stray byte desynchronises every client at once. That is invisible to a unit
 *    test and catastrophic in practice.
 *
 * It also guards the module-graph split that keeps `@modelcontextprotocol/sdk` off the
 * hook's startup path — see the last describe block.
 *
 * Runs under vitest.built.config.ts because it needs `npm run build` first.
 */

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const CLI = join(DIST, 'cli.js')

const PENDING = {
  id: '019fef13-1d76-7000-9fbf-91e24ad5889b',
  status: 'pending',
  comment: 'make this darker',
  app: '@acme/admin',
  element: { tag: 'button', selector: 'nav > button', text: 'Settings' },
}

const SECOND = {
  id: '019fef13-1d76-7000-9fbf-91e24ad5889c',
  status: 'pending',
  comment: 'move this left',
  element: { tag: 'div', selector: 'aside', text: 'Billing' },
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-mcp-built-'))
  mkdirSync(join(root, '.git'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeQueue(items: readonly unknown[]): void {
  const dir = join(root, '.dogear')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'queue.json'),
    `${JSON.stringify({ version: 1, updatedAt: null, items }, null, 2)}\n`,
  )
}

function readItems(): readonly { status: string; resolvedAt: string | null }[] {
  const raw = readFileSync(join(root, '.dogear', 'queue.json'), 'utf8')
  return (JSON.parse(raw) as { items: { status: string; resolvedAt: string | null }[] })
    .items
}

/**
 * Connect a real MCP client to `node dist/cli.js mcp`, spawned with `cwd` at the temp repo.
 *
 * `cwd` is the whole repo-resolution story for D1 — clients differ on where they spawn a
 * server from, and this is the mechanism under test, not an incidental detail.
 */
async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: root,
    stderr: 'pipe',
  })

  const client = new Client({ name: 'dogear-built-suite', version: '0.0.0' })
  await client.connect(transport)

  return { client, close: () => client.close() }
}

function textOf(result: unknown): string {
  const { content } = result as { content: { type: string; text?: string }[] }
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

describe('the built `dogear mcp` server, driven by a real MCP client', () => {
  it('completes the initialize handshake and lists the three tools', async () => {
    const { client, close } = await connect()

    try {
      const { tools } = await client.listTools()

      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'dogear_pending',
        'dogear_prune',
        'dogear_resolve',
      ])
      expect(tools.every((tool) => (tool.description ?? '').length > 0)).toBe(true)
    } finally {
      await close()
    }
  })

  it('returns the formatted block from dogear_pending', async () => {
    writeQueue([PENDING])
    const { client, close } = await connect()

    try {
      const result = await client.callTool({ name: 'dogear_pending', arguments: {} })

      expect(result.isError ?? false).toBe(false)
      expect(textOf(result)).toContain('<dogear-queue count="1">')
      expect(textOf(result)).toContain('make this darker')
      expect(textOf(result)).toContain('call dogear_resolve with its id')
      expect((result.structuredContent as { count: number }).count).toBe(1)
    } finally {
      await close()
    }
  })

  it('filters to one workspace package', async () => {
    writeQueue([PENDING, SECOND])
    const { client, close } = await connect()

    try {
      const result = await client.callTool({
        name: 'dogear_pending',
        arguments: { app: '@acme/admin' },
      })

      expect((result.structuredContent as { count: number }).count).toBe(1)
      expect(textOf(result)).not.toContain('move this left')
    } finally {
      await close()
    }
  })

  it('resolves through the tool, and the change reaches the FILE', async () => {
    // D2's central claim, end to end: the agent never edits JSON, and a tool call cannot
    // corrupt the queue.
    writeQueue([PENDING, SECOND])
    const { client, close } = await connect()

    try {
      const result = await client.callTool({
        name: 'dogear_resolve',
        arguments: { ids: [PENDING.id] },
      })

      expect(result.structuredContent).toEqual({ resolved: 1, remaining: 1 })

      const [first] = readItems()
      expect(first?.status).toBe('resolved')
      expect(typeof first?.resolvedAt).toBe('string')

      // And it stops appearing, which is the part the user actually notices.
      const after = await client.callTool({ name: 'dogear_pending', arguments: {} })
      expect((after.structuredContent as { count: number }).count).toBe(1)
      expect(textOf(after)).not.toContain('make this darker')
    } finally {
      await close()
    }
  })

  it('treats an unknown id as a no-op rather than an error', async () => {
    writeQueue([PENDING])
    const { client, close } = await connect()

    try {
      const result = await client.callTool({
        name: 'dogear_resolve',
        arguments: { ids: ['nothing-like-this'] },
      })

      expect(result.isError ?? false).toBe(false)
      expect(result.structuredContent).toEqual({ resolved: 0, remaining: 1 })
    } finally {
      await close()
    }
  })

  it('prunes resolved items and reports the count', async () => {
    writeQueue([{ ...PENDING, status: 'resolved', resolvedAt: null }, SECOND])
    const { client, close } = await connect()

    try {
      const result = await client.callTool({ name: 'dogear_prune', arguments: {} })

      expect(result.structuredContent).toEqual({ pruned: 1 })
      expect(readItems()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('reports a corrupt queue as a tool error without dying', async () => {
    // The session must survive: an exception reaching the transport would break every later
    // call, not just this one.
    mkdirSync(join(root, '.dogear'), { recursive: true })
    writeFileSync(join(root, '.dogear', 'queue.json'), '{"version":1,"items":[')

    const { client, close } = await connect()

    try {
      const failed = await client.callTool({ name: 'dogear_pending', arguments: {} })
      expect(failed.isError).toBe(true)

      // Still alive afterwards.
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(3)
    } finally {
      await close()
    }
  })
})

describe('the built `dogear mcp` process itself', () => {
  it('writes ZERO BYTES to stdout when no client says anything', async () => {
    // The failure that breaks every client at once. A banner, a debug line, or a stray
    // newline ahead of the first frame desynchronises the peer's parser and the server
    // simply appears to hang.
    const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: root })

    let stdout = 0
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.byteLength
    })

    const exitCode = await new Promise<number>((resolve) => {
      setTimeout(() => child.stdin.end(), 300)
      child.on('close', (code) => resolve(code ?? 0))
    })

    expect(stdout).toBe(0)
    // Closing the pipe is how an MCP session ends normally, so this is a clean exit.
    expect(exitCode).toBe(0)
  })

  it('exits 1 with the reason on STDERR outside a git repository', async () => {
    // The deliberate opposite of the hook. A server that started anyway would answer "no
    // annotations" forever, which reads as an empty queue rather than a broken install.
    const outside = mkdtempSync(join(tmpdir(), 'dogear-no-repo-'))

    try {
      const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: outside })

      let stdout = 0
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.byteLength
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 0))
      })

      expect(exitCode).toBe(1)
      expect(stdout).toBe(0)
      expect(stderr).toContain('no git repository')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('the built bundle', () => {
  const chunks = (): readonly { name: string; source: string }[] =>
    readdirSync(DIST)
      .filter((name) => name.endsWith('.js'))
      .map((name) => ({ name, source: readFileSync(join(DIST, name), 'utf8') }))

  const staticImports = (source: string): readonly string[] =>
    [...source.matchAll(/^import[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(
      (match) => match[1] ?? '',
    )

  it('keeps the MCP SDK OUT of the entry chunk, so `dogear hook` never loads it', () => {
    // The reason ./src/mcp.ts reaches ./src/server.ts through a dynamic import and why
    // tsup.config.ts sets `splitting: true`. Without the split, tsup inlines the dynamic
    // import and the SDK becomes a top-level import of the file Claude Code spawns on every
    // single prompt. Its sibling guard is ./hook.test.ts's 2s budget.
    const entry = readFileSync(CLI, 'utf8')

    expect(staticImports(entry).some((id) => id.includes('modelcontextprotocol'))).toBe(
      false,
    )
  })

  it('loads the SDK from exactly one chunk, so the laziness is real', () => {
    const bearing = chunks().filter(({ source }) =>
      staticImports(source).some((id) => id.includes('modelcontextprotocol')),
    )

    expect(bearing).toHaveLength(1)
    expect(bearing[0]?.name).not.toBe('cli.js')
  })

  it('imports no transport that could open a socket — zero egress by construction', () => {
    // dogear's hard rule is that nothing leaves localhost. Rather than promising it, this
    // asserts the only SDK entry points in the bundle are the three stdio-side ones:
    // `streamableHttp` and `sse` would each bring a real network transport with them.
    const sdkImports = chunks()
      .flatMap(({ source }) => staticImports(source))
      .filter((id) => id.includes('modelcontextprotocol'))

    expect([...new Set(sdkImports)].sort()).toEqual([
      '@modelcontextprotocol/sdk/server/index.js',
      '@modelcontextprotocol/sdk/server/stdio.js',
      '@modelcontextprotocol/sdk/types.js',
    ])
  })

  it('keeps the shebang on the entry, which is what makes the bin executable', () => {
    expect(readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })
})
