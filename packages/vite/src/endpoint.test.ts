import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createEndpoint, DEFAULT_ENDPOINT, normaliseEndpoint } from './endpoint.js'
import { queuePathFor, readQueue } from './queue.js'

/**
 * Driven over real HTTP rather than through fabricated req/res objects.
 *
 * The middleware's job is almost entirely about protocol behaviour — status codes, an
 * Allow header, a streamed body it must stop reading partway. Mocks would let every one of
 * those assertions pass while the real thing hung or crashed. A `node:http` server on an
 * ephemeral port costs a millisecond and tests what actually ships.
 */

let root: string
let server: Server
let origin: string
let fellThrough: boolean

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dogear-endpoint-'))
  fellThrough = false

  const middleware = createEndpoint({ gitRoot: root, endpoint: DEFAULT_ENDPOINT })

  server = createServer((req, res) => {
    middleware(req, res, () => {
      // Stands in for Vite's remaining middleware stack. Anything reaching here was NOT
      // handled by dogear, which several tests below assert in both directions.
      fellThrough = true
      res.statusCode = 418
      res.end('fell through')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

function post(body: string, path = `${DEFAULT_ENDPOINT}/annotations`): Promise<Response> {
  return fetch(`${origin}${path}`, { method: 'POST', body })
}

const ONE_COMMENT = JSON.stringify({
  version: 1,
  batch: [{ comment: 'shade this darker' }],
})

describe('normaliseEndpoint', () => {
  it.each([
    { input: '/__dogear', expected: '/__dogear', why: 'already canonical' },
    { input: '/__dogear/', expected: '/__dogear', why: 'a trailing slash is dropped' },
    { input: '__dogear', expected: '/__dogear', why: 'a leading slash is added' },
    { input: '  /__x  ', expected: '/__x', why: 'surrounding whitespace is trimmed' },
    { input: '/a/b/', expected: '/a/b', why: 'nested paths survive' },
  ])('turns $input into $expected — $why', ({ input, expected }) => {
    expect(normaliseEndpoint(input)).toBe(expected)
  })

  it.each(['/', '', '   '])(
    'refuses %j, which would put dogear in front of every request',
    (input) => {
      expect(() => normaliseEndpoint(input)).toThrow(/below the site root/)
    },
  )
})

describe('POST /__dogear/annotations', () => {
  it('writes the batch and reports what it did', async () => {
    const response = await post(ONE_COMMENT)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      written: 1,
      pending: 1,
      queuePath: '.dogear/queue.json',
    })
  })

  it('reports queuePath with forward slashes on every platform', async () => {
    const body = (await (await post(ONE_COMMENT)).json()) as { queuePath: string }

    // A Windows dev server and a POSIX one must describe the same file the same way.
    expect(body.queuePath).not.toContain('\\')
  })

  it('persists the annotation with the server-owned fields stamped', async () => {
    await post(ONE_COMMENT)

    const [item] = readQueue(queuePathFor(root)).items

    expect(item).toMatchObject({ comment: 'shade this darker', status: 'pending' })
    expect(item?.resolvedAt).toBeNull()
    expect(item?.id).toMatch(/^[0-9a-f]{8}-/)
  })

  it('accepts a batch with no Content-Type — provable with curl alone is the point', async () => {
    // The story is written so that a bare `curl -d '{...}'` works. Requiring a header would
    // make the acceptance criterion false for the exact command in the issue.
    expect((await post(ONE_COMMENT)).status).toBe(200)
  })

  it('accumulates across submissions rather than replacing', async () => {
    await post(ONE_COMMENT)
    const second = await post(
      JSON.stringify({ version: 1, batch: [{ comment: 'and this' }] }),
    )

    await expect(second.json()).resolves.toMatchObject({ written: 1, pending: 2 })
  })

  it('does not create the file for an empty batch', async () => {
    const response = await post(JSON.stringify({ version: 1, batch: [] }))

    await expect(response.json()).resolves.toMatchObject({ written: 0, pending: 0 })
    expect(existsSync(queuePathFor(root))).toBe(false)
  })
})

describe('rejections leave the queue untouched', () => {
  it('returns 400 for malformed JSON — AC4', async () => {
    const response = await post('{ not json')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ ok: false })
    expect(existsSync(queuePathFor(root))).toBe(false)
  })

  it('leaves an EXISTING queue byte-identical when the JSON is malformed', async () => {
    // The half of AC4 that a missing-file assertion cannot reach.
    await post(ONE_COMMENT)
    const before = readFileSync(queuePathFor(root), 'utf8')

    await post('{ not json')

    expect(readFileSync(queuePathFor(root), 'utf8')).toBe(before)
  })

  it.each([
    { why: 'the version is wrong', body: { version: 2, batch: [] } },
    { why: 'batch is missing', body: { version: 1 } },
    { why: 'a comment is empty', body: { version: 1, batch: [{ comment: '' }] } },
  ])('returns 400 when $why', async ({ body }) => {
    const response = await post(JSON.stringify(body))

    expect(response.status).toBe(400)
    expect((await response.json()) as { errors: string[] }).toHaveProperty('errors')
  })

  it('writes NOTHING when one item in a batch is invalid — all or nothing', async () => {
    // A partially written batch is worse than a rejection: the user sees a success, and
    // the agent receives some of what they said.
    const response = await post(
      JSON.stringify({
        version: 1,
        batch: [{ comment: 'good' }, { comment: '' }, { comment: 'also good' }],
      }),
    )

    expect(response.status).toBe(400)
    expect(existsSync(queuePathFor(root))).toBe(false)
  })

  it('returns 413 for a body past the cap, without buffering it', async () => {
    const response = await post(
      JSON.stringify({ version: 1, batch: [{ comment: 'x'.repeat(2_000_000) }] }),
    )

    expect(response.status).toBe(413)
    expect(existsSync(queuePathFor(root))).toBe(false)
  })

  it('returns 500 and preserves the bytes when the queue on disk is corrupt', async () => {
    const queuePath = queuePathFor(root)
    mkdirSync(dirname(queuePath), { recursive: true })
    const corrupt = '{"version":1,"items":[ TRUNCATED'
    writeFileSync(queuePath, corrupt)

    const response = await post(ONE_COMMENT)

    expect(response.status).toBe(500)
    expect(readFileSync(queuePath, 'utf8')).toBe(corrupt)
  })
})

describe('routing', () => {
  it('answers an unknown path under the base itself, rather than falling through', async () => {
    // Falling through would hand this to Vite's SPA fallback, which returns index.html and
    // a 200 — a typo'd path would look like a successful request that returned a web page.
    const response = await post('{}', `${DEFAULT_ENDPOINT}/nope`)

    expect(response.status).toBe(404)
    expect(fellThrough).toBe(false)
  })

  it('answers the bare base path with 404 too', async () => {
    expect((await post('{}', DEFAULT_ENDPOINT)).status).toBe(404)
  })

  it('returns 405 with an Allow header for the wrong method', async () => {
    const response = await fetch(`${origin}${DEFAULT_ENDPOINT}/annotations`)

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('passes everything outside the base path straight through', async () => {
    const response = await fetch(`${origin}/src/main.tsx`)

    expect(fellThrough).toBe(true)
    expect(response.status).toBe(418)
  })

  it('is not fooled by a path that merely starts with the same characters', async () => {
    // `/__dogearsomething` must not be treated as living under `/__dogear`.
    await fetch(`${origin}${DEFAULT_ENDPOINT}something`)

    expect(fellThrough).toBe(true)
  })

  it('ignores a query string when matching', async () => {
    const response = await post(ONE_COMMENT, `${DEFAULT_ENDPOINT}/annotations?t=1`)

    expect(response.status).toBe(200)
  })
})

describe('a custom endpoint', () => {
  it('serves the configured base path and nothing else', async () => {
    const custom = createEndpoint({ gitRoot: root, endpoint: normaliseEndpoint('/__x/') })
    const customServer = createServer((req, res) => {
      custom(req, res, () => {
        res.statusCode = 418
        res.end()
      })
    })

    await new Promise<void>((resolve) => customServer.listen(0, '127.0.0.1', resolve))
    const customOrigin = `http://127.0.0.1:${(customServer.address() as AddressInfo).port}`

    try {
      const ok = await fetch(`${customOrigin}/__x/annotations`, {
        method: 'POST',
        body: ONE_COMMENT,
      })
      const missed = await fetch(`${customOrigin}/__dogear/annotations`, {
        method: 'POST',
      })

      expect(ok.status).toBe(200)
      expect(missed.status).toBe(418)
    } finally {
      await new Promise<void>((resolve) => customServer.close(() => resolve()))
    }
  })
})
