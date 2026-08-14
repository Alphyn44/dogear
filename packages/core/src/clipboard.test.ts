// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText, toStoredAnnotations } from './clipboard.js'
import type { AnnotationDraft, QueueItem } from './queue.js'
import { createQueue } from './queue.js'

/**
 * D4's (#23) clipboard, and the shape conversion that feeds it.
 *
 * **Both browser APIs need installing by hand, and neither for the same reason.**
 *
 * `document.execCommand` does not exist in happy-dom at all, so `vi.spyOn` throws rather than
 * stubbing — it has to be defined onto the document and deleted again. That absence is not an
 * inconvenience to work around: it is the same shape as a browser predating the API, which is
 * exactly why `copyViaTextarea` feature-detects instead of calling it blind. An unguarded call
 * would be a `TypeError` here and in `session.test.ts` both.
 *
 * `navigator.clipboard` *does* exist in happy-dom, but every method routes through
 * `navigator.permissions` first — so asserting against the real implementation would be
 * asserting about happy-dom's permission defaults. Spy on the method instead. Simulating its
 * absence needs the property redefined, since it is a getter with no setter and a plain
 * assignment silently does nothing.
 */

function draft(
  comment: string,
  overrides: Partial<AnnotationDraft> = {},
): AnnotationDraft {
  return {
    comment,
    sites: [
      { file: 'src/Button.tsx', line: 20, column: 4, tag: 'button', via: 'attribute' },
    ],
    element: {
      tag: 'button',
      selector: 'nav.tab-bar > button:nth-of-type(1)',
      id: null,
      classes: ['tab'],
      text: 'Settings',
    },
    url: 'http://localhost:5173/settings',
    viewport: { w: 1512, h: 945, dpr: 2 },
    authoredAt: '2026-08-11T10:00:00.000Z',
    ...overrides,
  }
}

function items(...drafts: AnnotationDraft[]): readonly QueueItem[] {
  const queue = createQueue()
  for (const entry of drafts) queue.add(entry)
  return queue.items
}

/** Install a working `document.execCommand`, or remove it entirely. */
function stubExecCommand(result: boolean | null): ReturnType<typeof vi.fn> | null {
  if (result === null) {
    Reflect.deleteProperty(document, 'execCommand')
    return null
  }

  const command = vi.fn(() => result)
  Object.defineProperty(document, 'execCommand', {
    value: command,
    configurable: true,
    writable: true,
  })
  return command
}

/**
 * Take `navigator.clipboard` away — the non-secure-origin case D4's third criterion names.
 *
 * An **own** property shadowing the prototype getter, which is what makes it reversible: the
 * `afterEach` below deletes it and the real accessor is back. A plain assignment does nothing
 * at all, since the accessor has no setter.
 */
function removeClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'execCommand')
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('copyText', () => {
  describe('the async clipboard path', () => {
    it('writes the text and reports success', async () => {
      const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()

      await expect(copyText('the block')).resolves.toBe(true)
      expect(writeText).toHaveBeenCalledExactlyOnceWith('the block')
    })

    it('leaves nothing behind in the document', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()

      await copyText('the block')

      expect(document.documentElement.querySelector('textarea')).toBeNull()
    })
  })

  describe('the hidden-textarea fallback', () => {
    it('is taken when navigator.clipboard is absent — the non-secure-origin case', async () => {
      removeClipboard()
      const command = stubExecCommand(true)

      await expect(copyText('the block')).resolves.toBe(true)
      expect(command).toHaveBeenCalledWith('copy')
    })

    it('is taken when writeText rejects', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
        new Error('permission denied'),
      )
      const command = stubExecCommand(true)

      await expect(copyText('the block')).resolves.toBe(true)
      expect(command).toHaveBeenCalledWith('copy')
    })

    it('puts the text in a selectable field, not a hidden one', async () => {
      // `hidden` or `display: none` makes the element unselectable and the copy a silent
      // no-op, which is the failure mode this whole path exists to avoid.
      removeClipboard()

      // An array rather than a `let`, because the assignment happens inside a callback and
      // TypeScript's flow analysis does not follow it — a nullable local would still be typed
      // `null` at the assertions below.
      const seen: HTMLTextAreaElement[] = []
      Object.defineProperty(document, 'execCommand', {
        value: vi.fn(() => {
          const field = document.documentElement.querySelector('textarea')
          if (field !== null) seen.push(field)
          return true
        }),
        configurable: true,
        writable: true,
      })

      await copyText('line one\nline two')

      expect(seen).toHaveLength(1)
      expect(seen[0]?.value).toBe('line one\nline two')
      expect(seen[0]?.hidden).toBe(false)
    })

    it('removes the field whether the copy worked or not', async () => {
      removeClipboard()

      stubExecCommand(true)
      await copyText('ok')
      expect(document.documentElement.querySelector('textarea')).toBeNull()

      stubExecCommand(false)
      await copyText('not ok')
      expect(document.documentElement.querySelector('textarea')).toBeNull()
    })

    it('reports failure when execCommand declines', async () => {
      removeClipboard()
      stubExecCommand(false)

      await expect(copyText('the block')).resolves.toBe(false)
    })

    it('reports failure without throwing when execCommand does not exist', async () => {
      // A browser predating the API, and happy-dom itself. The caller announces a failed copy
      // in the badge; an exception would take the whole keydown handler with it.
      removeClipboard()
      stubExecCommand(null)

      await expect(copyText('the block')).resolves.toBe(false)
    })

    it('does not throw when execCommand itself throws', async () => {
      removeClipboard()
      Object.defineProperty(document, 'execCommand', {
        value: vi.fn(() => {
          throw new Error('nope')
        }),
        configurable: true,
        writable: true,
      })

      await expect(copyText('the block')).resolves.toBe(false)
      expect(document.documentElement.querySelector('textarea')).toBeNull()
    })
  })
})

describe('toStoredAnnotations', () => {
  it('strips the local key', () => {
    // ./queue.ts: anything id-shaped on an annotation will eventually be mistaken for the
    // server's id. The key never leaves the tab, including into a clipboard block.
    const [item] = toStoredAnnotations(items(draft('shade this darker')), '')

    expect(item).toBeDefined()
    expect('key' in item!).toBe(false)
  })

  it('carries no id, because the server owns identity', () => {
    const [item] = toStoredAnnotations(items(draft('shade this darker')), '')

    expect(item?.id).toBe('')
  })

  it('marks the items pending', () => {
    // What `stampAnnotation` would write the moment they were submitted, and the only value
    // that survives `pendingOnly` if anything ever routes these through it.
    const [item] = toStoredAnnotations(items(draft('shade this darker')), '')

    expect(item?.status).toBe('pending')
  })

  it('passes the fields the formatter renders straight through', () => {
    const [item] = toStoredAnnotations(items(draft('shade this darker')), '')

    expect(item?.comment).toBe('shade this darker')
    expect(item?.url).toBe('http://localhost:5173/settings')
    expect(item?.sites).toEqual([
      { file: 'src/Button.tsx', line: 20, column: 4, tag: 'button', via: 'attribute' },
    ])
  })

  it('stamps the batch note onto every item', () => {
    // Per item rather than once, matching how it reaches queue.json — the brief's Decisions
    // log has the argument: a batch-scoped note is orphaned by the first resolve.
    const stamped = toStoredAnnotations(
      items(draft('one'), draft('two')),
      'these are all in the settings tab',
    )

    expect(stamped).toHaveLength(2)
    for (const item of stamped)
      expect(item.note).toBe('these are all in the settings tab')
  })

  it.each([{ note: '' }, { note: '   ' }, { note: '\n\t ' }])(
    'omits the note entirely for $note',
    ({ note }) => {
      // `panel.note` is the raw textarea value and the formatter's `asString` rejects only
      // the empty string — so an all-whitespace note would render a blank `note:` line above
      // every comment. Same trim `buildBatch` applies.
      const [item] = toStoredAnnotations(items(draft('one')), note)

      expect(item).toBeDefined()
      expect('note' in item!).toBe(false)
    },
  )

  it('trims a note that has content', () => {
    const [item] = toStoredAnnotations(items(draft('one')), '  check the spacing  ')

    expect(item?.note).toBe('check the spacing')
  })

  it('cannot have its server-owned fields overwritten by a draft', () => {
    // Client fields first, server fields last — the ordering `stampAnnotation` uses, for the
    // same reason. A draft is assembled in the browser and must not be able to claim an id.
    const forged = items(draft('one'))[0]!
    const [item] = toStoredAnnotations(
      [{ ...forged, id: 'forged', status: 'resolved' } as QueueItem],
      '',
    )

    expect(item?.id).toBe('')
    expect(item?.status).toBe('pending')
  })

  it('returns an empty list for an empty batch', () => {
    expect(toStoredAnnotations([], 'a note')).toEqual([])
  })
})
