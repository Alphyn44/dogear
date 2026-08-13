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
    /** Written as the Vite root's `package.json` name — C4's (#18) derivation input. */
    packageName?: string
    /** Passed as `dogear({ app })`, which must beat whatever `packageName` declares. */
    app?: string
  } = {},
): Promise<Fixture> {
  const gitRoot = mkdtempSync(join(tmpdir(), 'dogear-persist-'))
  if (options.git !== false) mkdirSync(join(gitRoot, '.git'))

  const viteRoot = join(gitRoot, 'packages', 'apps', 'web')
  mkdirSync(viteRoot, { recursive: true })
  writeFileSync(join(viteRoot, 'index.html'), '<!doctype html><html><head></head></html>')
  if (options.packageName !== undefined) {
    writeFileSync(
      join(viteRoot, 'package.json'),
      JSON.stringify({ name: options.packageName }),
    )
  }

  const server = await createServer({
    root: viteRoot,
    logLevel: 'silent',
    // Bound explicitly rather than left to Vite's `localhost` default, which resolves to
    // ::1 on Windows and 127.0.0.1 elsewhere — the test would dial the wrong stack on one
    // platform and get ECONNREFUSED. Port 0 lets the OS pick, so a developer's own dev
    // server on 5173 cannot collide with this.
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      dogear({
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.app === undefined ? {} : { app: options.app }),
      }),
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

  // C4 (#18), end to end. The fixture's Vite root already sits three levels below the git
  // root, which is the shape the package-name walk exists for.
  it('tags the annotation with its origin and workspace package — C4', async () => {
    const { origin, gitRoot } = await startFixture({ packageName: '@acme/web' })

    await fetch(`${origin}/__dogear/annotations`, { method: 'POST', body: BATCH })

    const [item] = readQueue(queuePathFor(gitRoot)).items

    // The origin is the one the request arrived at, read from its Host header — the same
    // base URL this test dialled.
    expect(item?.['origin']).toBe(origin)
    // Derived by walking up from the Vite root, not from the git root: the queue is shared
    // and the package name is what tells two apps in it apart.
    expect(item?.['app']).toBe('@acme/web')
  })

  it('omits app when no package.json above the Vite root names one', async () => {
    const { origin, gitRoot } = await startFixture()

    await fetch(`${origin}/__dogear/annotations`, { method: 'POST', body: BATCH })

    const [item] = readQueue(queuePathFor(gitRoot)).items

    expect(item !== undefined && 'app' in item).toBe(false)
    // The rest of the annotation is unaffected — a nameless package is an ordinary config,
    // not a degraded state, and nothing warns about it.
    expect(item?.['origin']).toBe(origin)
  })

  it('lets a configured app beat the derived one', async () => {
    const { origin, gitRoot } = await startFixture({
      packageName: '@acme/web',
      app: 'the-storefront',
    })

    await fetch(`${origin}/__dogear/annotations`, { method: 'POST', body: BATCH })

    expect(readQueue(queuePathFor(gitRoot)).items[0]?.['app']).toBe('the-storefront')
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
