import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readRegistry, registryKey, registryPath } from 'dogear-queue'
import type { Plugin, ViteDevServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UNBUILT_CORE_WARNING } from './client.js'
import { dogear } from './index.js'

/**
 * The plugin's half of E5's (#30) machine-level registry.
 *
 * **A file of its own rather than cases in ./index.test.ts**, which shares one temp root across
 * every test in it — these need a fresh registry per case, and a `DOGEAR_HOME` leaked into that
 * file would be read by every test after it.
 *
 * **The fake server here has an `httpServer`, and that is the only difference from
 * ./index.test.ts's.** Its one has none, so every case there takes the middleware-mode branch
 * and registers nothing — which is why none of them needed changing when this landed, and
 * worth knowing before adding an `httpServer` to that fixture for some unrelated reason.
 */

let home: string
let root: string
let path: string
let saved: string | undefined

beforeEach(() => {
  saved = process.env.DOGEAR_HOME
  home = mkdtempSync(join(tmpdir(), 'dogear-vite-home-'))
  process.env.DOGEAR_HOME = home
  path = registryPath()

  root = mkdtempSync(join(tmpdir(), 'dogear-vite-root-'))
  writeFileSync(join(root, '.git'), 'gitdir: /elsewhere')
})

afterEach(() => {
  if (saved === undefined) delete process.env.DOGEAR_HOME
  else process.env.DOGEAR_HOME = saved

  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

/** Enough of `http.Server` for the plugin, with the events under the test's control. */
class FakeHttpServer {
  private readonly handlers = new Map<string, () => void>()

  constructor(private readonly result: { port: number } | string | null) {}

  once(event: string, handler: () => void): this {
    this.handlers.set(event, handler)
    return this
  }

  address(): { port: number } | string | null {
    return this.result
  }

  fire(event: string): void {
    this.handlers.get(event)?.()
  }
}

interface Harness {
  readonly warnings: string[]
  readonly httpServer: FakeHttpServer | null
}

function run(
  options: Parameters<typeof dogear>[0] = {},
  harness: Partial<Harness> = {},
): Harness {
  const warnings: string[] = []
  const httpServer =
    harness.httpServer === undefined
      ? new FakeHttpServer({ port: 5174 })
      : harness.httpServer

  const server = {
    config: {
      root,
      server: {},
      logger: {
        // Not recorded, for the reason ./index.test.ts's fake logger gives at length: core's
        // build state is environmental, and nothing in this file is about it.
        warn: (m: string) => {
          if (m !== UNBUILT_CORE_WARNING) warnings.push(m)
        },
        info: () => {},
      },
    },
    middlewares: { use: () => {} },
    httpServer,
  } as unknown as ViteDevServer

  const plugin: Plugin = dogear(options)
  const hook = plugin.configureServer
  if (typeof hook !== 'function')
    throw new Error('expected configureServer as a function')
  ;(hook as (s: ViteDevServer) => void).call(plugin as never, server)

  return { warnings, httpServer }
}

function entry() {
  return readRegistry(path).projects[registryKey(root)]
}

describe('the plugin registering its dev server', () => {
  it('writes nothing until the server is actually listening', () => {
    // The port is not known before this: Vite moves to the next free one when the configured
    // port is taken, so anything recorded in configureServer would be a guess.
    run()

    expect(readRegistry(path).projects).toEqual({})
  })

  it('records the origin, pid and app once listening fires', () => {
    const { httpServer } = run({ app: 'react-app' })
    httpServer?.fire('listening')

    expect(entry()?.servers).toHaveLength(1)
    expect(entry()?.servers[0]).toMatchObject({
      origin: 'http://localhost:5174',
      pid: process.pid,
      app: 'react-app',
    })
  })

  it('uses the LISTENING port, not the configured one', () => {
    const { httpServer } = run({}, { httpServer: new FakeHttpServer({ port: 5199 }) })
    httpServer?.fire('listening')

    expect(entry()?.servers[0]?.origin).toBe('http://localhost:5199')
  })

  it('creates the entry for a repo that never ran dogear init', () => {
    const { httpServer } = run()
    httpServer?.fire('listening')

    // Visible in `dogear status` even though init never wrote anything here.
    expect(entry()?.initialisedAt).toBeUndefined()
    expect(entry()?.root).toBe(root)
  })

  it('removes its record when the server closes', () => {
    const { httpServer } = run()
    httpServer?.fire('listening')
    httpServer?.fire('close')

    expect(entry()?.servers).toEqual([])
  })

  it('registers nothing in middleware mode, and says nothing about it', () => {
    // No httpServer means Vite is mounted inside someone else's server: there is no origin of
    // dogear's to record, and nothing has gone wrong.
    const { warnings } = run({}, { httpServer: null })

    expect(readRegistry(path).projects).toEqual({})
    expect(warnings).toEqual([])
  })

  it('records nothing for a UNIX socket, which has no origin', () => {
    const { httpServer } = run({}, { httpServer: new FakeHttpServer('/tmp/vite.sock') })
    httpServer?.fire('listening')

    expect(readRegistry(path).projects).toEqual({})
  })

  it('warns and keeps serving when the registry cannot be written', () => {
    // The trade the missing-git-root branch already makes: the user came here to work on their
    // app, and status being unable to list this repo is not worth a failed dev server start.
    writeFileSync(path, '{ nope')

    const { httpServer, warnings } = run()
    expect(() => httpServer?.fire('listening')).not.toThrow()

    expect(warnings.some((m) => m.includes('could not record this dev server'))).toBe(
      true,
    )
  })

  it('registers nothing when the plugin is disabled by option', () => {
    // A disabled project is not running dogear, so it has no dev server to advertise.
    const { httpServer } = run({ enabled: false })
    httpServer?.fire('listening')

    expect(readRegistry(path).projects).toEqual({})
  })

  it('registers nothing outside a git repository', () => {
    rmSync(join(root, '.git'))

    const { httpServer } = run()
    httpServer?.fire('listening')

    expect(readRegistry(path).projects).toEqual({})
  })
})
