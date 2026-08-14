import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { StoredAnnotation } from '@dogear/queue'
import { queuePathFor, readQueue } from '@dogear/queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TOOLS, callTool, pending, prune, resolve } from './tools.js'

/**
 * The substance of D1, driven without a transport.
 *
 * Everything the MCP server can do is a function in ./tools.ts, so all of it is testable
 * here in the fast suite. ../test-built/mcp.test.ts covers only what genuinely needs a
 * process: the handshake, and stdout carrying nothing but protocol frames.
 */

let root: string
let queuePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-tools-'))
  queuePath = queuePathFor(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function annotation(overrides: Partial<StoredAnnotation> = {}): StoredAnnotation {
  return {
    id: '019fef13-1d76-7000-9fbf-91e24ad5889b',
    status: 'pending',
    comment: 'make this darker',
    element: { tag: 'button', selector: 'nav > button', text: 'Settings' },
    ...overrides,
  }
}

function seed(items: readonly StoredAnnotation[]): void {
  writeRaw(JSON.stringify({ version: 1, updatedAt: null, items }, null, 2))
}

function writeRaw(contents: string): void {
  mkdirSync(dirname(queuePath), { recursive: true })
  writeFileSync(queuePath, contents)
}

describe('TOOLS', () => {
  it('exposes exactly the three the brief names', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'dogear_pending',
      'dogear_resolve',
      'dogear_prune',
    ])
  })

  it.each(TOOLS.map((tool) => ({ name: tool.name, tool })))(
    '$name declares a description and an object-typed schema pair',
    ({ tool }) => {
      // MCP is pull: nothing calls a tool unless the agent chooses to, so an empty
      // description is a tool that never runs.
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.inputSchema['type']).toBe('object')
      expect(tool.outputSchema['type']).toBe('object')
    },
  )

  it('requires ids on resolve and nothing on pending or prune', () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool]))

    expect(byName.get('dogear_resolve')?.inputSchema['required']).toEqual(['ids'])
    expect(byName.get('dogear_pending')?.inputSchema['required']).toBeUndefined()
    expect(byName.get('dogear_prune')?.inputSchema['required']).toBeUndefined()
  })

  describe('the instructions carried in descriptions — D2', () => {
    // These two sentences are load-bearing rather than explanatory, and until D2 nothing
    // asserted their content: the whole table above only checked that descriptions were
    // longer than 40 characters, so either could have been deleted in a tidy-up and every
    // test would still have passed.
    const descriptionOf = (name: string): string =>
      TOOLS.find((tool) => tool.name === name)?.description ?? ''

    it('dogear_pending tells the agent to resolve what it addresses', () => {
      // The MCP-only baseline's only route to this instruction. `format.ts`'s footer says
      // the same thing, but a client that renders structuredContent drops the text block
      // and the footer with it — which is exactly what Claude Code does.
      expect(descriptionOf('dogear_pending')).toContain('call dogear_resolve with')
    })

    it('dogear_resolve forbids hand-editing the queue', () => {
      // D2's first acceptance criterion, in the one place an agent is guaranteed to read.
      const description = descriptionOf('dogear_resolve')

      expect(description).toContain('Never edit .dogear/queue.json by hand')
      expect(description).toContain('only supported way to resolve')
    })

    it('dogear_resolve says an unknown id is not an error', () => {
      // Without this, an agent replaying a stale transcript reads a 0 count as a failure
      // and retries — the reason the no-op rule exists at all.
      expect(descriptionOf('dogear_resolve')).toContain('not an error')
    })
  })
})

describe('dogear_pending', () => {
  it('returns the pending items, and only those', () => {
    seed([
      annotation({ id: 'a', comment: 'todo' }),
      annotation({ id: 'b', comment: 'done', status: 'resolved' }),
    ])

    const outcome = pending(root, {})

    expect(outcome.isError).toBe(false)
    expect(outcome.structured['count']).toBe(1)
    expect(outcome.text).toContain('todo')
    expect(outcome.text).not.toContain('done')
  })

  it('renders through the SHARED formatter, footer included', () => {
    // The seam the brief cares about: the hook and the server must not drift. If this ever
    // stops matching format.ts's output, one of the two is rendering its own thing.
    seed([annotation()])

    expect(pending(root, {}).text).toContain('<dogear-queue count="1">')
    expect(pending(root, {}).text).toContain('call dogear_resolve with its id')
  })

  it('says something rather than nothing for an empty queue', () => {
    // formatQueue returns '' so the hook can put zero bytes on stdout. A tool returning an
    // empty text block tells the agent nothing at all, so this substitutes a sentence.
    const outcome = pending(root, {})

    expect(outcome.text).not.toBe('')
    expect(outcome.text).toContain('No pending dogear annotations')
    expect(outcome.structured['count']).toBe(0)
  })

  it('RE-READS on every call, so nothing is cached at server start', () => {
    // The server lives for the whole session while a dev server keeps appending. A cached
    // read would make the agent's second question return the first question's answer.
    expect(pending(root, {}).structured['count']).toBe(0)

    seed([annotation()])

    expect(pending(root, {}).structured['count']).toBe(1)
  })

  describe('the app filter', () => {
    beforeEach(() => {
      seed([
        annotation({ id: 'a', comment: 'admin one', app: '@acme/admin' }),
        annotation({ id: 'b', comment: 'site one', app: '@acme/site' }),
        annotation({ id: 'c', comment: 'no app at all' }),
      ])
    })

    it('keeps only the named package', () => {
      const outcome = pending(root, { app: '@acme/admin' })

      expect(outcome.structured['count']).toBe(1)
      expect(outcome.text).toContain('admin one')
    })

    it('excludes an item that carries no app', () => {
      expect(pending(root, { app: '@acme/admin' }).text).not.toContain('no app at all')
    })

    it('names the overall count when the FILTER is what emptied the result', () => {
      // Otherwise the agent reads "none pending" and stops, when the truth is "none in that
      // package, three in the repo".
      const outcome = pending(root, { app: '@acme/nothing' })

      expect(outcome.isError).toBe(false)
      expect(outcome.text).toContain('3 annotations pending in this repo overall')
    })
  })

  it('reports a corrupt queue as an error instead of an empty one', () => {
    // The difference between a hook and a tool call. A hook must degrade to silence; a tool
    // has an error channel, and an agent told "nothing pending" would conclude there is no
    // work and move on.
    writeRaw('{"version":1,"items":[ TRUNCATED')

    const outcome = pending(root, {})

    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain(queuePath)
    expect(outcome.structured).toEqual({})
  })

  it('still returns the healthy items when ONE entry is malformed', () => {
    // Tolerant on the read path: one bad entry in a hand-edited file costs that entry, not
    // the other two.
    seed([
      annotation({ id: 'a', comment: 'good' }),
      { comment: 'no id' } as unknown as StoredAnnotation,
      annotation({ id: 'c', comment: 'also good' }),
    ])

    const outcome = pending(root, {})

    expect(outcome.isError).toBe(false)
    expect(outcome.structured['count']).toBe(2)
  })
})

describe('dogear_resolve', () => {
  it('marks an item done and reports the counts', () => {
    seed([annotation({ id: 'a' }), annotation({ id: 'b' })])

    const outcome = resolve(root, { ids: ['a'] })

    expect(outcome.isError).toBe(false)
    expect(outcome.structured).toEqual({ resolved: 1, remaining: 1 })
    expect(readQueue(queuePath).items[0]?.status).toBe('resolved')
  })

  it('takes an item out of the next dogear_pending', () => {
    seed([annotation({ id: 'a' })])
    resolve(root, { ids: ['a'] })

    expect(pending(root, {}).structured['count']).toBe(0)
  })

  it('treats an UNKNOWN id as a no-op and says so without erroring', () => {
    seed([annotation({ id: 'a' })])

    const outcome = resolve(root, { ids: ['not-in-the-queue'] })

    expect(outcome.isError).toBe(false)
    expect(outcome.structured).toEqual({ resolved: 0, remaining: 1 })
    expect(outcome.text).toContain('That is not an error')
  })

  it('counts only what it actually changed when a batch is part stale', () => {
    seed([annotation({ id: 'a' }), annotation({ id: 'b' })])

    const outcome = resolve(root, { ids: ['a', 'gone', 'b'] })

    expect(outcome.structured).toEqual({ resolved: 2, remaining: 0 })
    expect(outcome.text).toContain('1 requested id did not match')
  })

  it('refuses to write over a corrupt queue, leaving the bytes untouched', () => {
    // The strict reader, deliberately. The tolerant one drops malformed entries, so writing
    // back what it returned would delete them and call it a successful resolve.
    //
    // Driven through callTool because that is the throw boundary: `resolve` itself lets the
    // read throw, exactly as `appendToQueue` does for the plugin, and callTool is what turns
    // it into an answer the agent can act on. The next test pins that division.
    const corrupt = '{"version":1,"items":[ TRUNCATED'
    writeRaw(corrupt)

    const outcome = callTool(root, 'dogear_resolve', { ids: ['a'] })

    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain(queuePath)
    expect(readFileSync(queuePath, 'utf8')).toBe(corrupt)
  })

  it('throws out of `resolve` itself — callTool is the only place that catches', () => {
    // Pinning the division of labour rather than describing it. If someone later adds a
    // try/catch inside `resolve`, this fails and asks them to decide deliberately: the
    // functions are file I/O and throw like it, and exactly one adapter converts that.
    writeRaw('{"version":1,"items":[ TRUNCATED')

    expect(() => resolve(root, { ids: ['a'] })).toThrow(queuePath)
  })
})

describe('dogear_prune', () => {
  it('drops resolved items and reports the count', () => {
    seed([
      annotation({ id: 'a', status: 'resolved' }),
      annotation({ id: 'b' }),
      annotation({ id: 'c', status: 'resolved' }),
    ])

    const outcome = prune(root)

    expect(outcome.structured).toEqual({ pruned: 2 })
    expect(outcome.text).toContain('1 annotation still pending')
    expect(readQueue(queuePath).items).toHaveLength(1)
  })

  it('says so plainly when there is nothing to prune', () => {
    seed([annotation()])

    expect(prune(root).text).toContain('Nothing to prune')
    expect(prune(root).structured).toEqual({ pruned: 0 })
  })

  it('does not create .dogear in a repo that has never used dogear', () => {
    expect(prune(root).structured).toEqual({ pruned: 0 })
    expect(existsSync(dirname(queuePath))).toBe(false)
  })
})

describe('callTool', () => {
  it.each([
    { name: 'dogear_pending', args: {} },
    { name: 'dogear_prune', args: {} },
  ])('dispatches $name', ({ name, args }) => {
    expect(callTool(root, name, args).isError).toBe(false)
  })

  it('names the real tools when asked for one that does not exist', () => {
    const outcome = callTool(root, 'dogear_delete_everything', {})

    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('dogear_pending')
    expect(outcome.text).toContain('dogear_resolve')
    expect(outcome.text).toContain('dogear_prune')
  })

  it.each([
    { why: 'ids is missing', name: 'dogear_resolve', args: {} },
    { why: 'ids is a bare string', name: 'dogear_resolve', args: { ids: 'a' } },
    { why: 'ids is empty', name: 'dogear_resolve', args: { ids: [] } },
    { why: 'an id is a number', name: 'dogear_resolve', args: { ids: [1] } },
    { why: 'an id is empty', name: 'dogear_resolve', args: { ids: [''] } },
    { why: 'app is a number', name: 'dogear_pending', args: { app: 7 } },
    { why: 'app is empty', name: 'dogear_pending', args: { app: '' } },
    { why: 'the payload is an array', name: 'dogear_pending', args: [] },
    { why: 'the payload is a string', name: 'dogear_resolve', args: 'ids' },
  ])('reports rather than throws when $why', ({ name, args }) => {
    // Never a throw: an exception reaching the transport takes down the stdio session, so
    // one malformed call would break every later one instead of just itself.
    const outcome = callTool(root, name, args)

    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('dogear:')
  })

  it.each([
    { why: 'undefined', args: undefined },
    { why: 'null', args: null },
  ])('accepts $why arguments, since prune takes none and app is optional', ({ args }) => {
    expect(callTool(root, 'dogear_prune', args).isError).toBe(false)
    expect(callTool(root, 'dogear_pending', args).isError).toBe(false)
  })
})
