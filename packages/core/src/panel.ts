/**
 * B4 (#11) — the review panel.
 *
 * The batch is otherwise write-only: B3 (#10) can add to it and count it, and B5 (#12) will
 * write it to disk. This is the last point at which a mistake is cheap, which is what the
 * brief means by *"the review moment is deliberate — it's what makes batching a feature
 * rather than a delay."*
 *
 * Three structural choices, each of which removes a problem rather than managing one.
 *
 * **Editing is in place, and every row's comment is a live `<textarea>`** — not a
 * click-to-edit affordance. Reopening the comment box on the original element was the
 * alternative and it does not survive the workflow: you batch comments across several pages,
 * so by review time most items point at elements that are not in the current document and
 * there is nothing to anchor to. Always-live also means no mode to switch, nothing to
 * discover, and every row is already a tab stop — which is what makes {@link Panel.focusFirst}
 * worth doing.
 *
 * **Listeners are delegated**, registered once on the panel element through the registry,
 * with rows identified by `data-key`. Registering per row would leave the registry holding
 * handlers for deleted rows — a leak that `detachAll` would dutifully clean up long after it
 * mattered. `focusin`/`focusout` rather than `focus`/`blur`, because the latter do not bubble.
 *
 * **The list is rebuilt only on delete.** An edit's DOM already shows the committed text, and
 * an add cannot happen while the panel is open, because capturing an element closes the panel
 * (see `capture` in ./session.ts). So the usual re-render-destroys-the-caret problem has no
 * way to arise, rather than being worked around with a focus-restoring dance.
 *
 * Keys, not indices, throughout — see ./queue.ts.
 */

import { labelFor } from './describe.js'
import type { ListenerRegistry } from './listeners.js'
import type { QueueItem } from './queue.js'

/** What the panel asks the session to do. It mutates nothing itself. */
export interface PanelHandlers {
  onDelete(key: number): void
  /** The raw textarea value. The caller applies `acceptableComment` and may refuse. */
  onEdit(key: number, comment: string): void
}

export interface Panel {
  readonly element: HTMLElement
  readonly open: boolean
  /**
   * Is a row's textarea focused?
   *
   * Read by the session's Escape chain: while a row is being edited, Escape belongs to the
   * row (revert) rather than to the panel (close).
   */
  readonly editing: boolean
  show(items: readonly QueueItem[]): void
  hide(): void
  /** Rebuild the list. */
  render(items: readonly QueueItem[]): void
  focusFirst(): void
  /** Push the focused row's text to the handler. No-op when nothing is being edited. */
  commitEdit(): void
  /** Restore the focused row's text to what it was when focus arrived, and stop editing. */
  cancelEdit(): void
}

export interface PanelDeps {
  readonly registry: ListenerRegistry
  readonly handlers: PanelHandlers
}

export function createPanel({ registry, handlers }: PanelDeps): Panel {
  const element = document.createElement('div')
  element.className = 'panel'
  element.setAttribute('role', 'dialog')
  element.setAttribute('aria-label', 'dogear pending annotations')
  element.hidden = true

  const list = document.createElement('ul')
  list.className = 'items'
  element.append(list)

  /** The row being edited, and the text it held when focus arrived — what Escape restores. */
  let editingKey: number | null = null
  let textOnFocus = ''

  function rowInput(key: number): HTMLTextAreaElement | null {
    return list.querySelector(`[data-key="${String(key)}"] .item-comment`)
  }

  function focusedInput(): HTMLTextAreaElement | null {
    return editingKey === null ? null : rowInput(editingKey)
  }

  /**
   * `data-key` off the nearest row.
   *
   * Read from the DOM rather than closed over per row, which is the whole point of
   * delegation: one handler, and the row it acted on is whatever the event came from.
   */
  function keyOf(target: EventTarget | null): number | null {
    if (!(target instanceof Element)) return null

    const raw = target.closest('.item')?.getAttribute('data-key')
    if (raw === undefined || raw === null) return null

    const key = Number(raw)
    return Number.isFinite(key) ? key : null
  }

  registry.on(element, 'click', (event) => {
    if (!(event.target instanceof Element)) return
    if (!event.target.classList.contains('item-drop')) return

    const key = keyOf(event.target)
    if (key !== null) handlers.onDelete(key)
  })

  registry.on(element, 'focusin', (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return

    editingKey = keyOf(event.target)
    textOnFocus = event.target.value
  })

  registry.on(element, 'focusout', (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return

    // Blur commits, so clicking away from a row does not silently discard what was typed.
    // Escape gets its chance first — `cancelEdit` restores the text *and* clears `editingKey`,
    // so the commit this triggers sends the original value back and changes nothing.
    const key = keyOf(event.target)
    if (key !== null) handlers.onEdit(key, event.target.value)

    editingKey = null
    textOnFocus = ''
  })

  return {
    element,

    get open() {
      return !element.hidden
    },

    get editing() {
      return editingKey !== null
    },

    render(items) {
      list.replaceChildren(...items.map(row))
    },

    show(items) {
      this.render(items)
      element.hidden = false
    },

    hide() {
      element.hidden = true
      // Not carried across a close: the row that was focused is gone from the user's mind by
      // the time they reopen, and a stale key would make the next Escape revert a row nobody
      // touched.
      editingKey = null
      textOnFocus = ''
      list.replaceChildren()
    },

    focusFirst() {
      // A closed shadow root does not obstruct programmatic focus — `document.activeElement`
      // reports the host, which is how focus retargeting is specified. See ./box.ts.
      list.querySelector<HTMLTextAreaElement>('.item-comment')?.focus()
    },

    commitEdit() {
      const input = focusedInput()
      if (input === null || editingKey === null) return

      handlers.onEdit(editingKey, input.value)
    },

    cancelEdit() {
      const input = focusedInput()
      if (input === null) return

      input.value = textOnFocus
      editingKey = null
      textOnFocus = ''
      input.blur()
    },
  }
}

function row(item: QueueItem): HTMLLIElement {
  const element = document.createElement('li')
  element.className = 'item'
  element.setAttribute('data-key', String(item.key))

  const head = document.createElement('div')
  head.className = 'item-head'

  const label = document.createElement('span')
  label.className = 'item-label'
  label.textContent = labelFor(item.element)

  const page = document.createElement('span')
  page.className = 'item-page'
  page.textContent = pathOf(item.url)

  const drop = document.createElement('button')
  drop.className = 'item-drop'
  drop.type = 'button'
  // The visible glyph is a multiplication sign, which a screen reader reads as "times".
  drop.setAttribute('aria-label', `Delete annotation on ${labelFor(item.element)}`)
  drop.textContent = '×'

  head.append(label, page, drop)

  const comment = document.createElement('textarea')
  comment.className = 'item-comment'
  comment.rows = 2
  comment.value = item.comment

  element.append(head, comment)
  return element
}

/**
 * `/settings` from `http://localhost:5173/settings?tab=1`.
 *
 * The path alone, because the origin is the same for every item in a batch — the browser
 * POSTs same-origin, so one queue's items all came from one dev server. Which *page* is the
 * part that disambiguates, and it is why the row shows it at all: `button.tab — "Save"` is
 * the same label on two pages that share a component.
 *
 * `item.url` is always `location.href` and so always absolute, but a `URL` that throws would
 * take the whole panel down with it — falling back to the raw string keeps a row that is
 * merely ugly instead of a review step that will not render.
 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
