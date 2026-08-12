import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AnnotationDraft, QueueItem } from './queue.js'
import { createQueue } from './queue.js'
import { buildBatch, PROTOCOL_VERSION, submitBatch } from './submit.js'

/**
 * B5's (#12) wire, in the node environment.
 *
 * No DOM anywhere in here, which is the reason ./submit.ts is its own module: `fetch` is a
 * global that can be stubbed, and every outcome the panel has to render is reachable without
 * mounting an overlay. What is left for ./session.test.ts is the *ordering* — which items get
 * cleared, and when.
 */

const ENDPOINT = '/__dogear'

function draft(
  comment: string,
  overrides: Partial<AnnotationDraft> = {},
): AnnotationDraft {
  return {
    comment,
    element: { tag: 'button', id: null, classes: ['tab'], text: 'Settings' },
    url: 'http://localhost:5173/settings',
    viewport: { w: 1512, h: 945, dpr: 2 },
    authoredAt: '2026-08-11T10:00:00.000Z',
    ...overrides,
  }
}

function items(...comments: string[]): readonly QueueItem[] {
  const queue = createQueue()
  for (const comment of comments) queue.add(draft(comment))
  return queue.items
}

/** A `fetch` that resolves with a JSON body, the way the endpoint answers. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(response: Response | Error): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildBatch', () => {
  it('sends the protocol version the plugin validates against', () => {
    expect(buildBatch(items('a'), '').version).toBe(PROTOCOL_VERSION)
  })

  it('strips the local key — it never leaves the tab', () => {
    // The load-bearing assertion in this file. `stampAnnotation` spreads client fields
    // straight through, so an unrecognised extra rides into queue.json — and anything
    // id-shaped on an annotation will eventually be mistaken for the server's `id`.
    const body = buildBatch(items('a', 'b'), '')

    expect(body.batch).toHaveLength(2)
    for (const item of body.batch) expect('key' in item).toBe(false)
  })

  it('keeps every field the server does not own', () => {
    const [only] = buildBatch(items('too dark'), '').batch

    expect(only).toEqual(draft('too dark'))
  })

  it.each([
    { why: 'empty', note: '', present: false },
    { why: 'only whitespace', note: '   \n ', present: false },
    { why: 'a real instruction', note: 'all on the settings page', present: true },
  ])('a note that is $why lands on the body: $present', ({ note, present }) => {
    // Omitted rather than sent as "" — one representation of "no instruction" in a file
    // people read with `cat`.
    expect('note' in buildBatch(items('a'), note)).toBe(present)
  })

  it('trims a note it does send', () => {
    expect(buildBatch(items('a'), '  spaced  ').note).toBe('spaced')
  })

  it('sends an empty batch as an empty array rather than refusing', () => {
    // Refusing is the session's call — it has the queue and the panel. This is transport.
    expect(buildBatch([], '').batch).toEqual([])
  })
})

describe('submitBatch', () => {
  const body = buildBatch(items('a'), '')

  it('POSTs JSON to <endpoint>/annotations', async () => {
    stubFetch(jsonResponse(200, { ok: true, written: 1, pending: 1, queuePath: 'p' }))

    await submitBatch({ endpoint: ENDPOINT, body })

    expect(fetch).toHaveBeenCalledWith(
      '/__dogear/annotations',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  it('reports the server counts on a confirmed write', async () => {
    stubFetch(
      jsonResponse(200, {
        ok: true,
        written: 3,
        pending: 5,
        queuePath: '.dogear/queue.json',
      }),
    )

    expect(await submitBatch({ endpoint: ENDPOINT, body })).toEqual({
      ok: true,
      written: 3,
      pending: 5,
      queuePath: '.dogear/queue.json',
    })
  })

  it.each([
    {
      why: 'a 400 with the validator’s list',
      response: () =>
        jsonResponse(400, {
          ok: false,
          errors: ['batch[0].comment must be a non-empty string'],
        }),
      reason: 'batch[0].comment must be a non-empty string',
    },
    {
      why: 'a 400 with several problems, joined',
      response: () => jsonResponse(400, { ok: false, errors: ['first', 'second'] }),
      reason: 'first; second',
    },
    {
      why: 'a 500 with a single error',
      response: () =>
        jsonResponse(500, { ok: false, error: 'queue.json is not valid JSON' }),
      reason: 'queue.json is not valid JSON',
    },
    {
      why: 'a 413 over the body cap',
      response: () =>
        jsonResponse(413, { ok: false, error: 'body exceeds 1048576 bytes' }),
      reason: 'body exceeds 1048576 bytes',
    },
    {
      why: 'a non-JSON error page from something upstream',
      response: () => new Response('<html>502</html>', { status: 502 }),
      reason: 'The dev server answered 502.',
    },
  ])('surfaces $why', async ({ response, reason }) => {
    stubFetch(response())

    const result = await submitBatch({ endpoint: ENDPOINT, body })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe(reason)
  })

  it('reports a dead dev server as unreachable, not as a server error', async () => {
    stubFetch(new TypeError('Failed to fetch'))

    const result = await submitBatch({ endpoint: ENDPOINT, body })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain(
      'Could not reach the dev server',
    )
  })

  it('reports an abort as a timeout, in its own words', async () => {
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    stubFetch(aborted)

    const result = await submitBatch({ endpoint: ENDPOINT, body })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('did not respond within 10s')
  })

  it.each([
    { why: 'ok is false on a 200', payload: { ok: false, error: 'weird' } },
    { why: 'the body is an array', payload: [] },
    { why: 'the body is null', payload: null },
  ])('treats a 200 whose body is wrong as a failure — $why', async ({ payload }) => {
    // The whole point: the queue is the only copy of the user's work, so it is cleared on a
    // *confirmed* write and on nothing else. A 200 we cannot read is not a confirmation.
    stubFetch(jsonResponse(200, payload))

    expect((await submitBatch({ endpoint: ENDPOINT, body })).ok).toBe(false)
  })

  it('passes the abort signal through to fetch', async () => {
    stubFetch(jsonResponse(200, { ok: true, written: 1, pending: 1, queuePath: 'p' }))
    const controller = new AbortController()

    await submitBatch({ endpoint: ENDPOINT, body, signal: controller.signal })

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('never throws, whatever the server does', async () => {
    // A rejected promise out of a dev tool during page interaction is an unhandled rejection
    // in someone else's app. Every path here returns a result instead.
    stubFetch(new Error('something nobody predicted'))

    await expect(submitBatch({ endpoint: ENDPOINT, body })).resolves.toMatchObject({
      ok: false,
    })
  })
})
