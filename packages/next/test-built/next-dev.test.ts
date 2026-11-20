import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { discard, freePort, REPO_ROOT } from '../../../test-packed/fixture.js'

/**
 * J3 (#79) against a real Next 16: the rewrite, the proxy and the phase gate, which the unit
 * suite in ../src/index.test.ts can only stand in for.
 *
 * **The scratch app lives inside this package, not under `tmpdir`.** H3's suite copies its
 * fixture to `tmpdir` and junctions `node_modules` back, but Turbopack refuses to read files
 * outside its project root, and `next` realpaths through the junction into this repository. So
 * the copy goes to `packages/next/.scratch/` (gitignored), where Node finds the workspace's
 * modules by walking up, Turbopack's root (inferred from this repository's lockfile) contains
 * everything it reads, and a bare `.git` in the copy is still what `findGitRoot` stops at first.
 * That last part is what keeps every annotation out of the developer's own queue.
 *
 * The app consumes the **built** `dogear-next` through its exports map, as a user's would.
 *
 * Slow by nature: each `next dev` boots and compiles a page, and the production leg runs a full
 * `next build`. The timeouts are sized for a cold Windows machine.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixture')
const SCRATCH = join(HERE, '..', '.scratch')
const NEXT_BIN = join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')

const ONE = JSON.stringify({ version: 1, batch: [{ comment: 'from a real next dev' }] })

beforeAll(() => {
  if (!existsSync(join(REPO_ROOT, 'packages', 'next', 'dist', 'index.js'))) {
    throw new Error(
      'this suite consumes the built dogear-next, and dist/index.js is missing. ' +
        'Run `npm run build` first.',
    )
  }
})

/** A copy of the fixture app with its own git root and a generated `next.config.mjs`. */
function createApp(): string {
  mkdirSync(SCRATCH, { recursive: true })
  const root = mkdtempSync(join(SCRATCH, 'app-'))
  mkdirSync(join(root, '.git'))
  cpSync(FIXTURE, root, { recursive: true })

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'dogear-next-fixture', private: true, type: 'module' }, null, 2)}\n`,
  )
  writeFileSync(
    join(root, 'next.config.mjs'),
    [
      "import { withDogear } from 'dogear-next'",
      '',
      // `agentRules: false` because `next dev` otherwise writes an AGENTS.md on first run
      // (J1's spike), which is noise in a fixture and nothing this suite is about.
      //
      // `turbopack.root` because Turbopack bounds its root at the nearest git repository, and
      // the copy's own `.git` is exactly that boundary: left alone it reads nothing above the
      // copy and cannot find `next` itself. This repository's root contains both.
      'export default withDogear({',
      '  agentRules: false,',
      `  turbopack: { root: ${JSON.stringify(REPO_ROOT.replace(/\\/g, '/'))} },`,
      '})',
      '',
    ].join('\n'),
  )

  return root
}

interface Running {
  readonly origin: string
  readonly log: () => string
  readonly stop: () => Promise<void>
}

/**
 * Start a Next command in `root` and wait until `/` answers.
 *
 * **Stopping kills the whole tree.** `next dev` forks the server into a child process, and on
 * Windows `child.kill()` ends only the parent, leaving the child holding the port and file
 * handles on the scratch directory. `taskkill /T` takes the tree.
 */
async function startNext(root: string, args: readonly string[]): Promise<Running> {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`

  const child = spawn(
    process.execPath,
    [NEXT_BIN, ...args, '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Next's telemetry would be the suite's only network egress.
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    },
  )

  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))

  const stop = () => stopTree(child)

  const deadline = Date.now() + 120_000
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `next ${args.join(' ')} exited with ${String(child.exitCode)}:\n${log}`,
      )
    }
    try {
      const response = await fetch(`${origin}/`)
      if (response.ok) return { origin, log: () => log, stop }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop()
      throw new Error(
        `next ${args.join(' ')} did not serve ${origin} within 120s:\n${log}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function stopTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('close', () => resolve())
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill()
    }
  })
}

function readItems(root: string): readonly Record<string, unknown>[] {
  const path = join(root, '.dogear', 'queue.json')
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { items: Record<string, unknown>[] })
    .items
}

describe.each([
  { bundler: 'Turbopack', flags: [] as string[] },
  { bundler: 'webpack', flags: ['--webpack'] },
])('next dev under $bundler', ({ flags }) => {
  let root: string
  let next: Running

  beforeAll(async () => {
    root = createApp()
    next = await startNext(root, ['dev', ...flags])
  }, 180_000)

  afterAll(async () => {
    await next?.stop()
    if (root !== undefined) discard(root)
  }, 60_000)

  it('writes a submitted batch to the git root’s queue, with the page’s origin', async () => {
    const response = await fetch(`${next.origin}/__dogear/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ONE,
    })

    expect(response.status, next.log()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, written: 1 })

    const [item] = readItems(root)
    expect(item).toMatchObject({
      comment: 'from a real next dev',
      app: 'dogear-next-fixture',
      // The origin the request was sent to, through Next's proxy, not the loopback port.
      origin: next.origin,
    })
  }, 60_000)

  it('answers an unknown endpoint path with dogear’s 404, proving the rewrite reached it', async () => {
    const response = await fetch(`${next.origin}/__dogear/nope`)

    expect(response.status).toBe(404)
    // JSON naming dogear's routes, not Next's HTML not-found page.
    await expect(response.json()).resolves.toMatchObject({ ok: false })
  }, 60_000)

  it('refuses a malformed batch and leaves the queue as it was', async () => {
    const before = readItems(root).length

    const response = await fetch(`${next.origin}/__dogear/annotations`, {
      method: 'POST',
      body: '{ not json',
    })

    expect(response.status).toBe(400)
    expect(readItems(root)).toHaveLength(before)
  }, 60_000)

  it('started one endpoint server and said so once, despite the config being evaluated again', () => {
    const ready = next.log().match(/\[dogear\] ready/g) ?? []
    expect(ready, next.log()).toHaveLength(1)
  })
})

describe('next build, then next start', () => {
  let root: string
  let server: Running | undefined

  beforeAll(async () => {
    root = createApp()
    const build = spawnSync(process.execPath, [NEXT_BIN, 'build'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      timeout: 240_000,
    })
    if (build.status !== 0) {
      throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`)
    }
    server = await startNext(root, ['start'])
  }, 360_000)

  afterAll(async () => {
    await server?.stop()
    if (root !== undefined) discard(root)
  }, 60_000)

  it('builds with no rewrite to dogear', () => {
    const manifest = JSON.parse(
      readFileSync(join(root, '.next', 'routes-manifest.json'), 'utf8'),
    ) as { rewrites?: unknown }

    expect(JSON.stringify(manifest.rewrites ?? null)).not.toContain('__dogear')
  })

  it('serves no dogear endpoint in production, and writes nothing', async () => {
    const response = await fetch(`${server!.origin}/__dogear/annotations`, {
      method: 'POST',
      body: ONE,
    })

    expect(response.status).toBe(404)
    expect(existsSync(join(root, '.dogear'))).toBe(false)
  }, 60_000)

  it('said nothing about dogear while building or serving', () => {
    expect(server!.log()).not.toContain('[dogear]')
  })
})
