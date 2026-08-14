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
 *
 * B5 (#12) added the footer — the batch note, the submit button, and the status row a failed
 * POST lands in. It follows the same rule as everything above: the panel reports, and
 * ./session.ts applies. Nothing here reads the queue or touches the network.
 */

import { labelFor } from './describe.js'
import type { ListenerRegistry } from './listeners.js'
import type { QueueItem } from './queue.js'

/**
 * The panel's key hints, in the shape ./box.ts's `HINT` established.
 *
 * `Ctrl+Alt+D` and `Ctrl+Alt+P` written literally rather than as ⌃⌥D and ⌃⌥P, because the
 * bindings really are `ctrlKey && altKey` on every platform — neither is remapped to Command on
 * macOS — so the symbols would be the ambiguous form here, not the friendly one.
 *
 * D4's (#23) copy sits between the two it sits between in meaning: submit is the wired-up path,
 * copy is the floor beneath it, disable is the exit. "disable dogear" loses its second word to
 * make room — three bindings on one line is already what ./box.ts's `HINT` is doing, and the
 * word `dogear` is on the badge two inches away.
 */
export const FOOTER_HINT = '⌘/Ctrl+⏎ submit · Ctrl+Alt+P copy · Ctrl+Alt+D disable'

/** What the panel asks the session to do. It mutates nothing itself. */
export interface PanelHandlers {
  onDelete(key: number): void
  /** The raw textarea value. The caller applies `acceptableComment` and may refuse. */
  onEdit(key: number, comment: string): void
  /** B5 (#12). The panel does not read the queue or touch the network — see ./session.ts. */
  onSubmit(): void
  /**
   * B6 (#13). Reports the intent only — the session checks the queue and may refuse, and
   * the controller above it owns the teardown.
   */
  onDisable(): void
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
  /**
   * Is the batch note focused? The Escape chain's most-specific arm — see ./session.ts.
   *
   * Separate from {@link Panel.editing} rather than folded into it: they revert different
   * text, and a single flag would make Escape in the note restore some row's comment.
   */
  readonly noteEditing: boolean
  /** B5's (#12) batch-wide instruction, untrimmed. `buildBatch` decides what to send. */
  readonly note: string
  show(items: readonly QueueItem[]): void
  hide(): void
  /** Rebuild the list. */
  render(items: readonly QueueItem[]): void
  focusFirst(): void
  /** Push the focused row's text to the handler. No-op when nothing is being edited. */
  commitEdit(): void
  /** Restore the focused row's text to what it was when focus arrived, and stop editing. */
  cancelEdit(): void
  /** Restore the note to what it was when focus arrived, and blur. Panel stays open. */
  cancelNoteEdit(): void
  /** Emptied only on a confirmed write — a note outlives a failed submit. */
  clearNote(): void
  /** Disable submit while a POST is in flight, so one batch cannot be sent twice. */
  setBusy(busy: boolean): void
  /** Show a failure in the footer. The queue is intact; submit is re-enabled. */
  showError(reason: string): void
  clearStatus(): void
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

  /**
   * B5's (#12) footer, built once and **never touched by `hide()`**.
   *
   * `hide()` empties the list, because rows are rebuilt from the queue on every `show`. The
   * note is not: it is typed by the user and belongs to no item, so wiping it would mean
   * clicking the badge twice destroyed a sentence. It is cleared on a confirmed write and
   * on nothing else.
   */
  const footer = document.createElement('div')
  footer.className = 'footer'

  const note = document.createElement('textarea')
  note.className = 'note'
  note.rows = 2
  note.placeholder = 'Anything that applies to all of these? (optional)'
  note.setAttribute('aria-label', 'Note for the whole batch')

  const status = document.createElement('div')
  status.className = 'status'
  // A failed submit has to be *announced*, not merely drawn: the user pressed a button and
  // is watching the badge, which is somewhere else. `assertive` rather than `polite`
  // because it interrupts — the alternative is learning about it after the next action.
  status.setAttribute('role', 'alert')
  status.hidden = true

  const submit = document.createElement('button')
  submit.className = 'submit'
  submit.type = 'button'
  submit.textContent = 'Submit'

  /**
   * B6's (#13) toggle. In the panel because the panel is the only surface that exists on
   * demand — while idle with an empty queue dogear renders nothing at all (B7, #14), so a
   * control that were always reachable would cost exactly that guarantee.
   *
   * The title carries the way back, because this button is the last thing you see before
   * dogear disappears and there is nothing left in the page to ask.
   */
  const disable = document.createElement('button')
  disable.className = 'disable'
  disable.type = 'button'
  disable.textContent = 'Disable dogear'
  disable.title =
    'Turn dogear off, including after a reload. __dogear.start() brings it back.'

  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(disable, submit)

  /**
   * The chord, spelled out — the panel's counterpart to the comment box's key hints.
   *
   * It carries the discovery load for B6 (#13), and it has to, because the panel is only
   * reachable while the queue has something in it: with an empty queue dogear renders nothing
   * at all, so someone who wants it gone and has never read the docs has no in-page surface
   * to find. This line is where they learn the chord while they are here for another reason.
   */
  const hint = document.createElement('div')
  hint.className = 'footer-hint'
  hint.textContent = FOOTER_HINT

  footer.append(note, status, actions, hint)
  element.append(list, footer)

  /** The row being edited, and the text it held when focus arrived — what Escape restores. */
  let editingKey: number | null = null
  let textOnFocus = ''
  /** The note's own pair. See {@link Panel.noteEditing} for why it is not the same one. */
  let noteFocused = false
  let noteOnFocus = ''

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

    if (event.target === submit) {
      // Guarded here as well as by the `disabled` attribute: a click dispatched at a
      // disabled button is a no-op in a browser, but the button is also reachable from the
      // keyboard path in ./session.ts, and only one of the two can be the authority.
      if (!submit.disabled) handlers.onSubmit()
      return
    }

    if (event.target === disable) {
      // Blocked while a POST is in flight, on the same argument as Submit: the batch is
      // mid-air and the session is about to clear the items it sent. Tearing down underneath
      // that is the one ordering B5's snapshot logic cannot make safe.
      if (!submit.disabled) handlers.onDisable()
      return
    }

    if (!event.target.classList.contains('item-drop')) return

    const key = keyOf(event.target)
    if (key !== null) handlers.onDelete(key)
  })

  registry.on(element, 'focusin', (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return

    if (event.target === note) {
      noteFocused = true
      noteOnFocus = note.value
      return
    }

    editingKey = keyOf(event.target)
    textOnFocus = event.target.value
  })

  registry.on(element, 'focusout', (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return

    // The note needs no commit: unlike a row, it is not stored anywhere else, so the
    // textarea's own value *is* the state. Only the revert bookkeeping is cleared.
    if (event.target === note) {
      noteFocused = false
      noteOnFocus = ''
      return
    }

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

    get noteEditing() {
      return noteFocused
    },

    get note() {
      return note.value
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
      noteFocused = false
      noteOnFocus = ''
      list.replaceChildren()
      // The note deliberately survives — see the `footer` docblock above. So does the status
      // row, so a failure you closed the panel on is still there when you come back to it.
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

    cancelNoteEdit() {
      if (!noteFocused) return

      note.value = noteOnFocus
      noteFocused = false
      noteOnFocus = ''
      note.blur()
    },

    clearNote() {
      note.value = ''
      noteOnFocus = ''
    },

    setBusy(busy) {
      submit.disabled = busy
      submit.textContent = busy ? 'Submitting…' : 'Submit'
    },

    showError(reason) {
      status.textContent = reason
      status.classList.add('status-error')
      status.hidden = false
    },

    clearStatus() {
      status.textContent = ''
      status.classList.remove('status-error')
      status.hidden = true
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
