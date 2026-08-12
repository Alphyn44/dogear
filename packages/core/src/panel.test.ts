// @vitest-environment happy-dom

import type { Mock } from 'vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createListenerRegistry, type ListenerRegistry } from './listeners.js'
import type { Panel } from './panel.js'
import { createPanel } from './panel.js'
import type { AnnotationDraft, QueueItem } from './queue.js'
import { createQueue } from './queue.js'

/**
 * B4's (#11) panel, minus what needs a layout engine.
 *
 * The panel is mounted into the document here rather than into a shadow root: focus events
 * only fire for an element that is actually in a document, and `focusin`/`focusout` are how
 * the edit lifecycle is tracked. In the running overlay the same nodes live inside the closed
 * shadow root, which changes where focus is *reported* (the host) but not that it moves.
 */

let registry: ListenerRegistry
let panel: Panel
let onDelete: Mock<(key: number) => void>
let onEdit: Mock<(key: number, comment: string) => void>

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

/** A queue's worth of items, without going through a session. */
function items(...drafts: AnnotationDraft[]): readonly QueueItem[] {
  const queue = createQueue()
  for (const entry of drafts) queue.add(entry)
  return queue.items
}

function rows(): HTMLLIElement[] {
  return [...panel.element.querySelectorAll<HTMLLIElement>('li.item')]
}

function commentInput(index: number): HTMLTextAreaElement {
  const input = rows()[index]?.querySelector('.item-comment')
  if (!(input instanceof HTMLTextAreaElement)) throw new Error(`no row ${String(index)}`)
  return input
}

beforeEach(() => {
  document.body.innerHTML = ''
  registry = createListenerRegistry()
  onDelete = vi.fn<(key: number) => void>()
  onEdit = vi.fn<(key: number, comment: string) => void>()
  panel = createPanel({ registry, handlers: { onDelete, onEdit } })
  document.body.append(panel.element)
})

describe('rendering', () => {
  it('starts hidden and empty', () => {
    expect(panel.open).toBe(false)
    expect(rows()).toHaveLength(0)
  })

  it('lists a row per item, with comment, element label and page', () => {
    panel.show(items(draft('too dark'), draft('wrong copy')))

    expect(panel.open).toBe(true)
    expect(rows()).toHaveLength(2)
    expect(commentInput(0).value).toBe('too dark')
    expect(rows()[0]?.querySelector('.item-label')?.textContent).toBe(
      'button.tab — "Settings"',
    )
  })

  it('shows the path, not the whole URL — every item in a batch shares an origin', () => {
    panel.show(items(draft('a', { url: 'http://localhost:5173/settings?tab=1#frag' })))

    expect(rows()[0]?.querySelector('.item-page')?.textContent).toBe('/settings')
  })

  it('falls back to the raw string rather than taking the panel down on a bad URL', () => {
    panel.show(items(draft('a', { url: 'not a url' })))

    expect(rows()[0]?.querySelector('.item-page')?.textContent).toBe('not a url')
  })

  it('distinguishes two items whose element labels are identical', () => {
    // The reason the page is on the row at all: the same component on two pages renders the
    // same label, and you cannot tell which one you meant to drop.
    panel.show(
      items(
        draft('a', { url: 'http://localhost:5173/settings' }),
        draft('b', { url: 'http://localhost:5173/billing' }),
      ),
    )

    expect(
      rows().map((element) => element.querySelector('.item-page')?.textContent),
    ).toEqual(['/settings', '/billing'])
  })

  it('drops everything on hide, so a reopen cannot show a stale list', () => {
    panel.show(items(draft('a')))

    panel.hide()

    expect(panel.open).toBe(false)
    expect(rows()).toHaveLength(0)
  })
})

describe('delete', () => {
  it('reports the key of the row whose × was clicked', () => {
    const list = items(draft('a'), draft('b'))
    panel.show(list)

    rows()[1]?.querySelector<HTMLButtonElement>('.item-drop')?.click()

    expect(onDelete).toHaveBeenCalledWith(list[1]?.key)
  })

  it('still reports the right key after an earlier row was removed', () => {
    // The delegation test that matters. With array indices, dropping row 0 and then clicking
    // the × on what is now row 0 would report the wrong item.
    const list = items(draft('a'), draft('b'), draft('c'))
    panel.show(list)
    panel.render(list.slice(1))

    rows()[0]?.querySelector<HTMLButtonElement>('.item-drop')?.click()

    expect(onDelete).toHaveBeenCalledWith(list[1]?.key)
  })

  it('ignores a click that is not on a delete button', () => {
    panel.show(items(draft('a')))

    commentInput(0).click()

    expect(onDelete).not.toHaveBeenCalled()
  })
})

describe('editing', () => {
  it('is not editing until a row takes focus', () => {
    panel.show(items(draft('a')))

    expect(panel.editing).toBe(false)
  })

  it('tracks the focused row', () => {
    panel.show(items(draft('a')))

    commentInput(0).focus()

    expect(panel.editing).toBe(true)
  })

  it('commits the focused row on request', () => {
    const list = items(draft('before'))
    panel.show(list)
    commentInput(0).focus()
    commentInput(0).value = 'after'

    panel.commitEdit()

    expect(onEdit).toHaveBeenCalledWith(list[0]?.key, 'after')
  })

  it('commits nothing when no row is focused', () => {
    panel.show(items(draft('a')))

    panel.commitEdit()

    expect(onEdit).not.toHaveBeenCalled()
  })

  it('reverts to the text the row held when focus arrived', () => {
    panel.show(items(draft('before')))
    commentInput(0).focus()
    commentInput(0).value = 'typed over it'

    panel.cancelEdit()

    expect(commentInput(0).value).toBe('before')
    expect(panel.editing).toBe(false)
  })

  it('does not send the abandoned text, only the restored value blur commits', () => {
    // cancelEdit blurs, which fires focusout, which commits — so onEdit is called, but with
    // the original text. The row must not be updated to what was typed and thrown away.
    const list = items(draft('before'))
    panel.show(list)
    commentInput(0).focus()
    commentInput(0).value = 'typed over it'

    panel.cancelEdit()

    expect(onEdit).toHaveBeenCalledWith(list[0]?.key, 'before')
    expect(onEdit).not.toHaveBeenCalledWith(list[0]?.key, 'typed over it')
  })

  it('commits on blur, so clicking away does not silently discard', () => {
    const list = items(draft('before'))
    panel.show(list)
    commentInput(0).focus()
    commentInput(0).value = 'after'

    commentInput(0).blur()

    expect(onEdit).toHaveBeenCalledWith(list[0]?.key, 'after')
    expect(panel.editing).toBe(false)
  })

  it('forgets the edit state on hide', () => {
    panel.show(items(draft('a')))
    commentInput(0).focus()

    panel.hide()

    expect(panel.editing).toBe(false)
  })
})

describe('focusFirst', () => {
  it('puts the caret in the first row, so the panel is keyboard-reachable', () => {
    panel.show(items(draft('a'), draft('b')))

    panel.focusFirst()

    expect(document.activeElement).toBe(commentInput(0))
    expect(panel.editing).toBe(true)
  })

  it('does not throw on an empty list', () => {
    panel.show([])

    expect(() => {
      panel.focusFirst()
    }).not.toThrow()
  })
})

describe('the listener registry', () => {
  it('attaches once, not per row, so deleted rows leave nothing behind', () => {
    // Delegation, asserted structurally. Per-row registration would make this grow with the
    // list and leave dead handlers in the registry after every delete.
    const before = registry.size

    panel.show(items(draft('a'), draft('b'), draft('c')))
    panel.render(items(draft('a')))

    expect(registry.size).toBe(before)
  })

  it('goes quiet after detachAll', () => {
    panel.show(items(draft('a')))

    registry.detachAll()
    rows()[0]?.querySelector<HTMLButtonElement>('.item-drop')?.click()

    expect(onDelete).not.toHaveBeenCalled()
  })
})
