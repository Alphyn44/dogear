import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Annotation } from 'dogear-queue'
import { appendToQueue, queuePathFor, readQueue, stampAnnotation } from 'dogear-queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hook } from './hook.js'
import { pending, resolve } from './tools.js'

/**
 * The hook and the MCP server agree about what is pending — D2 (#21).
 *
 * D2's second criterion is that resolved items "stop appearing in subsequent prompts", and
 * *prompts* is the hook's surface, not the server's. D1 proved both halves only within their
 * own surface: `dogear_resolve` removes an item from `dogear_pending`, and the hook omits an
 * item whose status is `resolved`. Nothing joined them, so the claim that actually matters —
 * resolve through MCP, then type a prompt and not see it — was never tested.
 *
 * It is not a claim either module can make alone. The two share nothing but
 * `<git-root>/.dogear/queue.json`, and they read it through *different* readers on purpose:
 * `dogear_pending` tolerates a corrupt file, the hook must, and the writers refuse it. This
 * file is where that arrangement is checked from the outside.
 *
 * **Fixtures are written through the real path** — `stampAnnotation` then `appendToQueue`,
 * the same two calls the Vite endpoint makes. The existing hook tests hand-write
 * `{ status: 'resolved' }` with no `resolvedAt`, which is a shape the resolve path never
 * actually produces; seeding for real is what makes the tests below about the system rather
 * than about a literal.
 *
 * ../test-built/agreement.test.ts makes the same claim across two *processes*. Everything
 * here shares one module instance, so it proves the file contract, not the binaries.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-agreement-'))
  mkdirSync(join(root, '.git'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Seed through the endpoint's own path, so the items carry the shape the plugin writes. */
function seed(...comments: readonly string[]): readonly Annotation[] {
  const annotations = comments.map((comment) =>
    stampAnnotation({
      comment,
      sites: [
        { file: 'src/App.tsx', line: 12, column: 5, tag: 'button', via: 'attribute' },
      ],
      element: { tag: 'button', selector: 'nav > button', text: 'Settings' },
    }),
  )

  appendToQueue(queuePathFor(root), annotations)
  return annotations
}

/** What the hook would inject this turn — `undefined` when it emits nothing at all. */
function injected(): string | undefined {
  const result = hook({ CLAUDE_PROJECT_DIR: root }, root)

  expect(result.exitCode).toBe(0)
  if (result.output === '') return undefined

  const envelope = JSON.parse(result.output) as {
    hookSpecificOutput: { additionalContext: string }
  }
  return envelope.hookSpecificOutput.additionalContext
}

function idOf(annotation: Annotation): string {
  return annotation.id
}

describe('the hook and the MCP tools, over one queue file', () => {
  it('BOTH see a freshly written annotation', () => {
    // The positive direction, and it is not a formality: every absence assertion below
    // would pass just as well against a hook that had quietly stopped emitting anything.
    seed('make this darker')

    expect(pending(root, {}).structured['count']).toBe(1)
    expect(injected()).toContain('make this darker')
  })

  it('an item resolved through the TOOL stops appearing in the HOOK', () => {
    // D2's second criterion, in the words it is actually written in. Resolve on one
    // surface, read on the other.
    const [first] = seed('already handled', 'still open')

    resolve(root, { ids: [idOf(first!)] })

    const context = injected()
    expect(context).not.toContain('already handled')
    expect(context).toContain('still open')
    expect(context).toContain('count="1"')
  })

  it('the hook honours the shape resolveInQueue actually writes, resolvedAt and all', () => {
    // The gap the hand-seeded fixtures leave. Existing hook tests use a bare
    // `status: 'resolved'`; the real writer also stamps `resolvedAt`, and nothing had ever
    // fed that combination to the hook.
    const [only] = seed('done and dated')
    resolve(root, { ids: [idOf(only!)] })

    const stored = readQueue(queuePathFor(root)).items[0]
    expect(stored?.status).toBe('resolved')
    expect(typeof stored?.resolvedAt).toBe('string')

    expect(injected()).toBeUndefined()
  })

  it('emits ZERO BYTES once the last pending item is resolved', () => {
    // A4's rule surviving a resolve. `UserPromptSubmit` injects stdout verbatim, so an
    // emptied queue has to cost nothing — not a blank block announcing there is nothing.
    const [only] = seed('the only one')

    resolve(root, { ids: [idOf(only!)] })

    expect(hook({ CLAUDE_PROJECT_DIR: root }, root)).toEqual({ output: '', exitCode: 0 })
  })

  it('resolves exactly what it was asked to, leaving the rest for the next prompt', () => {
    const [a, , c] = seed('alpha', 'bravo', 'charlie')

    resolve(root, { ids: [idOf(a!), idOf(c!)] })

    const context = injected()
    expect(context).toContain('bravo')
    expect(context).not.toContain('alpha')
    expect(context).not.toContain('charlie')
    expect(context).toContain('count="1"')
  })

  it('an UNKNOWN id changes nothing the hook can see', () => {
    // The no-op is observable as `{resolved: 0}` at the call site; this is the other half —
    // that it is also invisible from the surface a user actually looks at. An agent
    // replaying a stale transcript must not be able to disturb the next prompt.
    seed('untouched')
    const before = injected()

    expect(resolve(root, { ids: ['no-such-id'] }).structured).toEqual({
      resolved: 0,
      remaining: 1,
    })

    expect(injected()).toBe(before)
  })

  it('agrees item-for-item, not merely on the count', () => {
    // Both surfaces render from the same array, but they render it differently — the tool
    // returns annotations, the hook returns a formatted block. This pins that every id the
    // tool calls pending is one the hook actually put in front of the user.
    const [a, b, c] = seed('one', 'two', 'three')
    resolve(root, { ids: [idOf(b!)] })

    const { items } = pending(root, {}).structured as {
      items: readonly { id: string }[]
    }
    const context = injected() ?? ''

    expect(items.map((item) => item.id)).toEqual([idOf(a!), idOf(c!)])
    for (const item of items) expect(context).toContain(item.id)
    expect(context).not.toContain(idOf(b!))
  })

  it('both degrade to nothing on a corrupt queue, in their own ways', () => {
    // The one place they are *meant* to differ. The hook swallows and stays silent because
    // it cannot exit non-zero; the tool reports, because a tool call has an error channel.
    // Neither invents items, which is the property that matters here.
    seed('will be clobbered')
    const corrupt = '{"version":1,"items":[ TRUNCATED'
    writeFileSync(queuePathFor(root), corrupt, 'utf8')

    const outcome = pending(root, {})
    expect(outcome.isError).toBe(true)

    expect(hook({ CLAUDE_PROJECT_DIR: root }, root).output).toBe('')
    expect(readFileSync(queuePathFor(root), 'utf8')).toBe(corrupt)
  })
})
