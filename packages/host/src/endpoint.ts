import type { IncomingMessage, ServerResponse } from 'node:http'
import { relative, sep } from 'node:path'

import {
  appendToQueue,
  pendingOnly,
  queuePathFor,
  readQueue,
  stampAnnotation,
} from 'dogear-queue'

import { validateBatch } from './batch.js'
import type { ClientDist } from './client.js'
import { sendClientBundle, sendMissingBundleStub, sendSourcemap } from './client-route.js'

/**
 * The HTTP half of the pipe: `POST <endpoint>/annotations` → `.dogear/queue.json`, plus
 * `GET <endpoint>/client.js`, which is how dogear-core reaches the browser at all (B1, #8).
 *
 * `GET <endpoint>/queue` and `POST <endpoint>/prune` are both in the brief's endpoint table
 * and neither is built, for the same reason: nothing calls them. B5 found no caller for the
 * former (the POST response already returns `pending`, and the badge shows the local count),
 * and D6 shipped prune on the CLI and MCP surfaces instead — see the brief's Decisions log.
 * Neither is an oversight; give one a caller and it can be added in a dozen lines.
 *
 * The client route lives in this middleware rather than a second one, because the promise
 * below — everything under the base path is answered here — is only true if there is exactly
 * one place that can answer. Two middlewares would also leave the 404's `known` list naming
 * half the routes that exist.
 *
 * Cross-repo isolation is free here and worth not breaking: the browser POSTs same-origin,
 * so the dev server that served the page is the one that writes, and it already knows its
 * own root. Ports never enter the routing decision. Two repos both serving :5173 are simply
 * two processes with different `gitRoot` values closed over below.
 */

/** Matches Vite's own `/__vite_ping` convention. */
export const DEFAULT_ENDPOINT = '/__dogear'

/**
 * Bodies above this are rejected with 413 rather than buffered.
 *
 * A batch is a handful of short comments plus CSS selectors; a megabyte is already three
 * orders of magnitude more than that. Without a cap, a dev server holds whatever anyone
 * chooses to send it in memory.
 */
export const MAX_BODY_BYTES = 1024 * 1024

export interface EndpointOptions {
  /** Absolute path to the git root. The queue is resolved from here, never the Vite root. */
  readonly gitRoot: string
  /** Base path, already normalised by {@link normaliseEndpoint}. */
  readonly endpoint: string
  /**
   * Where dogear-core's dev build is, or `undefined` if it has not been built.
   *
   * `undefined` is served as a stub module rather than an error — see
   * {@link sendMissingBundleStub}.
   */
  readonly clientDist: ClientDist | undefined
  /**
   * The workspace package this dev server serves — C4 (#18). Stamped onto every annotation
   * written through it.
   *
   * `undefined` when there is no `package.json` above the Vite root, it declares no name, or
   * it would not parse. The field is then absent from the annotation entirely; a repo with
   * one package has nothing to disambiguate and loses nothing by it.
   */
  readonly app?: string
  /**
   * Read `origin` from `x-forwarded-host` rather than `Host`. J3 (#79).
   *
   * Set by `dogear-next` and nothing else. Under Next the browser's request reaches this
   * handler through a `beforeFiles` rewrite to a loopback server, and Next's proxy rewrites
   * `Host` to that server's own `127.0.0.1:<port>` (`changeOrigin: true`) while copying the
   * page's host into `x-forwarded-host`. Reading `Host` there would record a port nobody
   * browsed.
   *
   * Off by default, so a Vite dev server, which the browser reaches directly, keeps ignoring
   * a header any client could send. The trust is no wider under Next: the loopback server is
   * reachable only from this machine, which is also everyone who could have sent `Host`.
   */
  readonly forwarded?: boolean
}

/**
 * The handler {@link createEndpoint} returns: Connect's `NextHandleFunction` shape, spelled
 * out so this package needs nothing from Vite. Vite mounts it as middleware, and
 * `dogear-next` calls it from a plain `node:http` server with a 404 as `next`.
 */
export type EndpointHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void

/**
 * Normalise a configured base path: leading slash, no trailing slash.
 *
 * Throws on a base path that would be the site root. `dogear({ endpoint: '/' })` would put
 * dogear in front of every request in the application, which is never what someone means
 * and would be baffling to debug.
 *
 * **It must also be a path and nothing else — E7 (#40).** This value is not only where the
 * middleware mounts; `clientScriptSrc` turns it into the `src` of the injected `<script>`,
 * so `//evil.com` is a protocol-relative URL and the dev page would fetch dogear's bundle
 * from a third-party host. That contradicts "zero network egress" outright. A `?` or `#`
 * loses the same way in the other direction: the config parameter would land inside a query
 * string the endpoint had already opened, and core would read a truncated one.
 *
 * Checked here rather than in E7's file reader because this is the one function every
 * endpoint flows through, whichever layer supplied it. A plugin option was never a trust
 * boundary — `vite.config.ts` is executable code — but a *data file* that can point the
 * script tag off-host is a new shape of the same hole, and one rule closes both.
 */
export function normaliseEndpoint(endpoint: string): string {
  const trimmed = withoutTrailingSlashes(endpoint.trim())
  const normalised = trimmed.startsWith('/') ? trimmed : `/${trimmed}`

  if (normalised === '/') {
    throw new Error(
      `dogear: endpoint must be a path below the site root, received ${JSON.stringify(endpoint)}`,
    )
  }

  // After the leading-slash step, so `//evil.com` and a bare `/evil.com` written as
  // `//evil.com/` are both caught by the one test.
  if (normalised.startsWith('//')) {
    throw new Error(
      'dogear: endpoint must be a same-origin path, not a protocol-relative URL, received ' +
        JSON.stringify(endpoint),
    )
  }

  if (normalised.includes('?') || normalised.includes('#')) {
    throw new Error(
      `dogear: endpoint must be a path with no query or fragment, received ${JSON.stringify(endpoint)}`,
    )
  }

  return normalised
}

/**
 * `path` with every trailing `/` removed (#89).
 *
 * A loop rather than `replace(/\/+$/, '')`, which is quadratic: on a long run of slashes that
 * does not end the string, the engine retries the match from every slash in it. The value
 * only ever comes from the developer's own config, so this was never reachable from outside,
 * but a dev server should not be able to hang on a typo in its own config file.
 */
function withoutTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end -= 1
  return path.slice(0, end)
}

/**
 * Build the request handler.
 *
 * Requests under the base path are always answered here — 404 or 405 as appropriate —
 * rather than passed to `next()`. Falling through would hand them to Vite's SPA fallback,
 * which answers with `index.html` and a 200, so a typo'd path or a `GET` where a `POST`
 * belonged would look like a successful request that returned a web page.
 */
export function createEndpoint(options: EndpointOptions): EndpointHandler {
  const annotationsPath = `${options.endpoint}/annotations`
  // The map's public name matches the bundle's, because the served file IS core's
  // `dist/client.js` and its trailing `//# sourceMappingURL=client.js.map` asks for exactly
  // this. The bytes go out as tsup built them, with nothing rewritten. See ./client-route.ts.
  const clientPath = `${options.endpoint}/client.js`
  const sourcemapPath = `${options.endpoint}/client.js.map`
  const queuePath = queuePathFor(options.gitRoot)

  return function dogearEndpoint(req, res, next) {
    const pathname = (req.url ?? '').split('?')[0] ?? ''

    if (pathname !== options.endpoint && !pathname.startsWith(`${options.endpoint}/`)) {
      next()
      return
    }

    if (pathname === clientPath || pathname === sourcemapPath) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET')
        sendJson(res, 405, {
          ok: false,
          error: `${pathname} accepts GET, received ${req.method ?? 'nothing'}`,
        })
        return
      }

      const dist = options.clientDist
      if (dist === undefined) sendMissingBundleStub(res)
      else if (pathname === clientPath) sendClientBundle(res, dist.bundle)
      else if (dist.sourcemap !== undefined) sendSourcemap(res, dist.sourcemap)
      else {
        // The bundle is present but its map is not. A 404 is the honest answer and the one
        // DevTools already knows how to ignore quietly.
        sendJson(res, 404, {
          ok: false,
          error: `${pathname} is not available — dogear-core was built without a sourcemap`,
        })
      }
      return
    }

    if (pathname !== annotationsPath) {
      sendJson(res, 404, {
        ok: false,
        error: `unknown dogear endpoint ${pathname}`,
        known: [`POST ${annotationsPath}`, `GET ${clientPath}`, `GET ${sourcemapPath}`],
      })
      return
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendJson(res, 405, {
        ok: false,
        error: `${annotationsPath} accepts POST, received ${req.method ?? 'nothing'}`,
      })
      return
    }

    handleSubmit(req, res, queuePath, options).catch((error: unknown) => {
      // The catch-all exists so a throw cannot leave a dev server holding an open socket.
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    })
  }
}

async function handleSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  queuePath: string,
  { gitRoot, app, forwarded }: EndpointOptions,
): Promise<void> {
  let raw: string
  try {
    raw = await readBody(req)
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      sendJson(res, 413, {
        ok: false,
        error: `body exceeds ${MAX_BODY_BYTES} bytes`,
      })
      return
    }
    throw error
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (cause) {
    // AC4: malformed JSON is a 400, and nothing on disk is touched — note that the queue
    // has not been opened at this point, let alone written.
    sendJson(res, 400, {
      ok: false,
      errors: [`body is not valid JSON: ${messageOf(cause)}`],
    })
    return
  }

  const validation = validateBatch(body)
  if (!validation.ok) {
    sendJson(res, 400, { ok: false, errors: validation.errors })
    return
  }

  // Read the queue only now, so every rejection above leaves the file untouched by
  // construction rather than by remembering to.
  let result
  try {
    result =
      validation.batch.length === 0
        ? // Nothing to write. Rewriting the file to bump `updatedAt` for an empty batch
          // would be a pointless mutation of a file another process may be reading.
          { written: 0, pending: countPending(queuePath) }
        : appendToQueue(
            queuePath,
            validation.batch.map((input) =>
              stampAnnotation(input, {
                note: validation.note,
                origin: forwarded === true ? forwardedOriginOf(req) : originOf(req),
                app,
              }),
            ),
          )
  } catch (error) {
    // A corrupt or future-versioned queue lands here. 500 rather than 400: the request was
    // fine, the state on disk is not, and it is deliberately left as it is.
    sendJson(res, 500, { ok: false, error: messageOf(error) })
    return
  }

  sendJson(res, 200, {
    ok: true,
    written: result.written,
    pending: result.pending,
    queuePath: toPosix(relative(gitRoot, queuePath)),
  })
}

function countPending(queuePath: string): number {
  // `pendingOnly` rather than an inline predicate: what counts as pending is one rule, and
  // it lives with the queue. An inline copy here would be a second place to fix if D5 or a
  // later status ever changes it.
  return pendingOnly(readQueue(queuePath).items).length
}

/**
 * The origin this request arrived at — C4's (#18) `origin`, e.g. `http://localhost:5173`.
 *
 * Read from the request rather than from the server's own config, because one dev server
 * answers to several names: `localhost:5173`, `127.0.0.1:5173` and a `.local` mDNS name can
 * all reach the same process, and the annotation should record the one the browser was
 * actually looking at. `Host` is exactly that.
 *
 * **Scheme comes from the socket, not from `x-forwarded-proto`.** `encrypted` is set on a
 * `TLSSocket` and absent on a plain one, which correctly distinguishes a dev server started
 * with `server.https`. Trusting the forwarded header instead would let a client describe the
 * server's own identity, and buys nothing: F3's runtime guard only lets dogear run on
 * loopback, `*.localhost` and `*.local`, so the reverse-proxy hostnames that header exists
 * for never have an overlay to submit from. See dogear-core's host.ts.
 *
 * `undefined` when there is no usable `Host` — an HTTP/1.0 client may send none. The field
 * is then absent rather than `http://undefined`.
 */
function originOf(req: IncomingMessage): string | undefined {
  const host = req.headers.host?.trim()
  if (host === undefined || host === '') return undefined

  const scheme =
    (req.socket as { encrypted?: boolean }).encrypted === true ? 'https' : 'http'
  return `${scheme}://${host}`
}

/**
 * {@link originOf} for a request that arrived through Next's rewrite proxy, for J3 (#79). See
 * {@link EndpointOptions.forwarded} for why `Host` is wrong there.
 *
 * **The first value only**, since a forwarded header may be a comma-separated chain and the
 * first entry is the host the browser dialled.
 *
 * **No header means no origin**, never a fallback to `Host`, because under this flag `Host`
 * is known to name the loopback server.
 *
 * **The scheme is `http` unless `x-forwarded-proto` says `https`.** Next 16's proxy sends no
 * such header, so `next dev --experimental-https` records `http`. The socket cannot help
 * either, since it is the proxy's plain connection to the loopback server. The field is
 * descriptive, and a wrong scheme on a correct host still names the right dev server.
 */
function forwardedOriginOf(req: IncomingMessage): string | undefined {
  const host = firstValue(req.headers['x-forwarded-host'])
  if (host === undefined) return undefined

  const proto = firstValue(req.headers['x-forwarded-proto'])
  return `${proto === 'https' ? 'https' : 'http'}://${host}`
}

function firstValue(header: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(header) ? header.join(',') : header
  const first = joined?.split(',')[0]?.trim()
  return first === undefined || first === '' ? undefined : first
}

/** Thrown past the byte cap so the caller can answer 413 rather than guess. */
class BodyTooLarge extends Error {}

/**
 * Buffer the request body, refusing to hold more than {@link MAX_BODY_BYTES}.
 *
 * Past the cap it keeps *reading* but stops *retaining*, and drops what it already has.
 * That distinction is the whole design: memory stays bounded, which is the thing worth
 * protecting, while the socket keeps draining so the 413 is actually delivered.
 *
 * The two tempting shortcuts both fail. Pausing the stream leaves the client pushing at a
 * reader that never returns, and the request sits until a timeout — six seconds, measured.
 * Destroying it resets the connection before the client has read the response, so `fetch`
 * reports ECONNRESET and never sees the 413 at all.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = []
    let size = 0
    let rejected = false

    req.on('data', (chunk: Buffer) => {
      size += chunk.length

      if (size > MAX_BODY_BYTES) {
        if (!rejected) {
          rejected = true
          chunks = []
          reject(new BodyTooLarge())
        }
        return
      }

      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(payload))
  // Dev-only, same-origin, localhost. Nothing here is cacheable and a stale queue count
  // read from a proxy would be actively misleading.
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}

/** Forward slashes in responses, so a Windows client reads the same path a POSIX one does. */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
