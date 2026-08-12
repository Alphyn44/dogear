import type { IncomingMessage, ServerResponse } from 'node:http'
import { relative, sep } from 'node:path'

import type { Connect } from 'vite'

import { stampAnnotation, validateBatch } from './annotation.js'
import type { ClientDist } from './client.js'
import { sendClientBundle, sendMissingBundleStub, sendSourcemap } from './client-route.js'
import { appendToQueue, queuePathFor, readQueue } from './queue.js'

/**
 * The HTTP half of the pipe: `POST <endpoint>/annotations` → `.dogear/queue.json`, plus
 * `GET <endpoint>/client.js`, which is how @dogear/core reaches the browser at all (B1, #8).
 *
 * `GET <endpoint>/queue` arrives with B3's pending badge and `POST <endpoint>/prune` with
 * D6 — both are in the brief's endpoint table, and neither has a caller yet.
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
   * Where @dogear/core's dev build is, or `undefined` if it has not been built.
   *
   * `undefined` is served as a stub module rather than an error — see
   * {@link sendMissingBundleStub}.
   */
  readonly clientDist: ClientDist | undefined
}

/**
 * Normalise a configured base path: leading slash, no trailing slash.
 *
 * Throws on a base path that would be the site root. `dogear({ endpoint: '/' })` would put
 * dogear in front of every request in the application, which is never what someone means
 * and would be baffling to debug.
 */
export function normaliseEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  const normalised = trimmed.startsWith('/') ? trimmed : `/${trimmed}`

  if (normalised === '/') {
    throw new Error(
      `dogear: endpoint must be a path below the site root, received ${JSON.stringify(endpoint)}`,
    )
  }

  return normalised
}

/**
 * Build the connect middleware.
 *
 * Requests under the base path are always answered here — 404 or 405 as appropriate —
 * rather than passed to `next()`. Falling through would hand them to Vite's SPA fallback,
 * which answers with `index.html` and a 200, so a typo'd path or a `GET` where a `POST`
 * belonged would look like a successful request that returned a web page.
 */
export function createEndpoint(options: EndpointOptions): Connect.NextHandleFunction {
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
          error: `${pathname} is not available — @dogear/core was built without a sourcemap`,
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

    handleSubmit(req, res, queuePath, options.gitRoot).catch((error: unknown) => {
      // The catch-all exists so a throw cannot leave a dev server holding an open socket.
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    })
  }
}

async function handleSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  queuePath: string,
  gitRoot: string,
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
              stampAnnotation(input, { note: validation.note }),
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
  return readQueue(queuePath).items.filter((item) => item.status === 'pending').length
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
