import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createEndpoint } from 'dogear-host'

/**
 * The loopback server behind dogear's rewrite, for J3 (#79).
 *
 * Next offers a tool no middleware hook, so the J1 ruling is a plain `node:http` server on an
 * ephemeral `127.0.0.1` port running the same `createEndpoint` Vite mounts, with a
 * `beforeFiles` rewrite sending `<endpoint>/*` to it. The browser still talks only to the
 * server that served the page, and the port is private to this process rather than part of
 * any routing decision, so "cross-repo isolation is free" survives the move.
 *
 * **Once per process, and the state lives on `globalThis`.** Turbopack's dev server evaluates
 * `next.config` twice in one process (J1's spike), and a second server would be a listener the
 * first evaluation's rewrite never reaches. Module scope would be enough if every evaluation
 * shared this module instance; `globalThis` keeps it true even if Next re-imports the config's
 * dependencies between evaluations, at the cost of one `Symbol.for` key.
 */

export interface EndpointServerOptions {
  readonly gitRoot: string
  /** Already normalised. */
  readonly endpoint: string
  readonly app: string | undefined
}

export interface StartedServer {
  readonly port: number
  /** `false` when an earlier evaluation in this process already started it. */
  readonly fresh: boolean
}

interface Running {
  readonly server: Server
  readonly port: Promise<number>
}

interface ProcessState {
  readonly servers: Map<string, Running>
  /** Messages already printed, so a second config evaluation does not repeat them. */
  readonly said: Set<string>
}

const STATE = Symbol.for('dogear-next.state')

export function processState(): ProcessState {
  const holder = globalThis as { [STATE]?: ProcessState }
  holder[STATE] ??= { servers: new Map(), said: new Set() }
  return holder[STATE]
}

/**
 * Start the endpoint server for this git root and base path, or return the one already
 * running.
 *
 * Keyed on both, because nothing else about the server can differ between two evaluations of
 * one config: `app` is derived from the same `cwd` each time.
 *
 * **`unref()`**, so dogear can never be the reason a `next dev` that is shutting down stays
 * alive.
 *
 * **`clientDist` is `undefined` until J4.** The client route then answers with core's
 * missing-bundle stub, which is harmless while nothing injects a tag that asks for it.
 */
export async function startEndpointServer(
  options: EndpointServerOptions,
): Promise<StartedServer> {
  const { servers } = processState()
  const key = `${options.gitRoot}\0${options.endpoint}`

  const existing = servers.get(key)
  if (existing !== undefined) return { port: await existing.port, fresh: false }

  const handler = createEndpoint({
    gitRoot: options.gitRoot,
    endpoint: options.endpoint,
    // TODO(dogear): J4 (#80) resolves core's dev bundle here, and adds dogear-core as a
    // dependency so `resolveCoreDist` can find it from dogear-next's own location.
    clientDist: undefined,
    app: options.app,
    forwarded: true,
  })

  const server = createServer((req, res) => {
    handler(req, res, () => {
      // Only reachable by dialling the loopback port directly: the rewrite sends nothing
      // here that is outside the base path, and `createEndpoint` answers everything inside it.
      res.statusCode = 404
      res.end()
    })
  })

  const port = new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
  servers.set(key, { server, port })
  server.unref()

  try {
    return { port: await port, fresh: true }
  } catch (error) {
    // Forgotten, so a later evaluation can try again rather than awaiting a rejection forever.
    servers.delete(key)
    throw error
  }
}

/** Close every server this process started. For tests; Next never calls it. */
export async function stopEndpointServers(): Promise<void> {
  const state = processState()
  const running = [...state.servers.values()]
  state.servers.clear()
  state.said.clear()

  await Promise.all(
    running.map(
      ({ server }) =>
        new Promise<void>((resolve) => {
          if (!server.listening) resolve()
          else server.close(() => resolve())
        }),
    ),
  )
}
