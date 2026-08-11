import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ViteDevServer } from 'vite'
import { createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'

import { dogear } from './index.js'
import { queuePathFor, readQueue } from './queue.js'

/**
 * A2 end to end: a real Vite dev server, a real port, a real HTTP POST, a real file.
 *
 * `endpoint.test.ts` drives the middleware directly, which proves its protocol behaviour.
 * What it cannot prove is that the middleware is *reachable* once Vite has assembled its
 * own stack — that `configureServer` registered it early enough to beat the SPA fallback,
 * and that the git root was resolved from the right directory. Those are the two ways this
 * story fails in practice, and neither shows up without a real server.
 *
 * The fixture puts the Vite root THREE levels below the git root, because "the path
 * resolves to the git root, not the Vite root" is an acceptance criterion and a fixture
 * where the two coincide would satisfy it by accident.
 */

const BATCH = JSON.stringify({
  version: 1,
  batch: [{ comment: 'shade this darker', element: { tag: 'button' } }],
})

interface Fixture {
  readonly gitRoot: string
  readonly viteRoot: string
  readonly server: ViteDevServer
  readonly origin: string
}

let active: Fixture | undefined

afterEach(async () => {
  if (active === undefined) return
  await active.server.close()
  rmSync(active.gitRoot, { recursive: true, force: true })
  active = undefined
})

async function startFixture(
  options: {
    git?: boolean
    endpoint?: string
  } = {},
): Promise<Fixture> {
  const gitRoot = mkdtempSync(join(tmpdir(), 'dogear-persist-'))
  if (options.git !== false) mkdirSync(join(gitRoot, '.git'))

  const viteRoot = join(gitRoot, 'packages', 'apps', 'web')
  mkdirSync(viteRoot, { recursive: true })
  writeFileSync(join(viteRoot, 'index.html'), '<!doctype html><html><head></head></html>')

  const server = await createServer({
    root: viteRoot,
    logLevel: 'silent',
    // Bound explicitly rather than left to Vite's `localhost` default, which resolves to
    // ::1 on Windows and 127.0.0.1 elsewhere — the test would dial the wrong stack on one
    // platform and get ECONNREFUSED. Port 0 lets the OS pick, so a developer's own dev
    // server on 5173 cannot collide with this.
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      dogear(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ],
  })
  await server.listen()

  const { port } = server.httpServer?.address() as AddressInfo
  active = { gitRoot, viteRoot, server, origin: `http://127.0.0.1:${port}` }
  return active
}

describe('a real dev server', () => {
  it('persists a POSTed batch to disk — AC1, the curl proof', async () => {
    const { origin, gitRoot } = await startFixture()

    const response = await fetch(`${origin}/__dogear/annotations`, {
      method: 'POST',
      body: BATCH,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      written: 1,
      pending: 1,
      queuePath: '.dogear/queue.json',
    })

    const [item] = readQueue(queuePathFor(gitRoot)).items
    expect(item).toMatchObject({ comment: 'shade this darker', status: 'pending' })
  })

  it('writes to the GIT root, not the Vite root — AC2', async () => {
    const { origin, gitRoot, viteRoot } = await startFixture()

    await fetch(`${origin}/__dogear/annotations`, { method: 'POST', body: BATCH })

    expect(existsSync(queuePathFor(gitRoot))).toBe(true)
    // The failure this guards: three dev servers in one monorepo producing three queues,
    // and the agent reading whichever one it happened to find.
    expect(existsSync(queuePathFor(viteRoot))).toBe(false)
    expect(existsSync(join(gitRoot, 'packages', '.dogear'))).toBe(false)
  })

  it('beats the SPA fallback — the endpoint answers, not index.html', async () => {
    const { origin } = await startFixture()

    const response = await fetch(`${origin}/__dogear/annotations`, {
      method: 'POST',
      body: '{ not json',
    })

    // Registered from the returned-function form instead, this would be a 200 of HTML.
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('leaves an existing queue untouched when the JSON is malformed — AC4', async () => {
    const { origin, gitRoot } = await startFixture()
    await fetch(`${origin}/__dogear/annotations`, { method: 'POST', body: BATCH })
    const before = readFileSync(queuePathFor(gitRoot), 'utf8')

    await fetch(`${origin}/__dogear/annotations`, { method: 'POST', body: '{ not json' })

    expect(readFileSync(queuePathFor(gitRoot), 'utf8')).toBe(before)
  })

  it('still serves the app — dogear only claims its own base path', async () => {
    const { origin } = await startFixture()

    const response = await fetch(`${origin}/index.html`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<html')
  })

  it('honours a custom endpoint option', async () => {
    const { origin, gitRoot } = await startFixture({ endpoint: '/__notes/' })

    const custom = await fetch(`${origin}/__notes/annotations`, {
      method: 'POST',
      body: BATCH,
    })

    expect(custom.status).toBe(200)
    expect(readQueue(queuePathFor(gitRoot)).items).toHaveLength(1)
  })

  it('stays inert outside a git repository rather than guessing a location', async () => {
    const { origin, gitRoot } = await startFixture({ git: false })

    await fetch(`${origin}/__dogear/annotations`, { method: 'POST', body: BATCH })

    // No endpoint was registered, so nothing was written anywhere. The warning telling the
    // developer why goes through Vite's logger, silenced here.
    expect(existsSync(queuePathFor(gitRoot))).toBe(false)
  })
})
