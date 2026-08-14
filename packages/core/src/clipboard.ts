/**
 * D4 (#23) — the floor beneath MCP.
 *
 * `Ctrl+Alt+P` copies the batch this tab is holding, formatted exactly as `dogear_pending` and
 * `dogear hook` format it. No server, no protocol, no agent configuration — it works with a web
 * chat window, an agent nobody has written an adapter for, or a colleague on Slack. The brief
 * calls it annoying by design: it is the thing that always works, including when MCP is
 * misconfigured.
 *
 * **What is copied is the in-memory batch, not the queue file.** The browser has no way to read
 * `.dogear/queue.json` back — B5 found `GET /__dogear/queue` had no caller and it was never
 * built — and adding one would contradict the "no server" half of this ticket. So the items
 * here are drafts: they carry no `id`, because identity is the server's (see ./queue.ts), and
 * the formatter omits an absent one. That is also why the block closes with `footer: 'paste'`
 * rather than the `dogear_resolve` instruction: these annotations are not in the queue, so
 * there is nothing to resolve regardless of what tooling the reader has.
 *
 * This module owns the clipboard and the shape conversion, and nothing else. The chord, the
 * badge announcement and the revert timer live in ./session.ts, the same split the panel and
 * the badge already use: the thing that performs the operation does not also decide what the
 * overlay looks like afterwards.
 */

import type { StoredAnnotation } from '@dogear/queue/format'

import type { QueueItem } from './queue.js'

/**
 * Adapt the browser's drafts into what the shared formatter renders.
 *
 * Server-owned fields last, so a draft cannot overwrite them — the same client-fields-first
 * ordering `stampAnnotation` uses, for the same reason.
 *
 * - `id: ''` — a browser-minted id would be a v4 the server discards, or worse would survive
 *   into `queue.json` and break the time-sortability v7 was chosen for. The formatter renders
 *   the id only when it is a non-empty string, so the block reads `[1] — src/Button.tsx:20`.
 * - `status: 'pending'` — truthful (these are pending, just pending in RAM), identical to what
 *   `stampAnnotation` would write the moment they were submitted, and the only value that
 *   survives `pendingOnly` if anything ever routes these through it. `''` would be a lie that
 *   drops out of that filter with no error.
 * - `app` and `origin` are absent, because the server resolves both and a client cannot know
 *   them. `formatItem` degrades to printing its `app:` line from `url` alone.
 *
 * The note is trimmed and **omitted when empty**, matching `buildBatch` — `panel.note` is the
 * raw textarea value, and the formatter's `asString` rejects only `''`, not `'   '`, so an
 * all-whitespace note would otherwise render a blank `note:` line above every comment. Stamped
 * per item rather than once, because that is how it reaches `queue.json` too; see the brief's
 * Decisions log for why a batch-scoped note was rejected.
 */
export function toStoredAnnotations(
  items: readonly QueueItem[],
  note: string,
): readonly StoredAnnotation[] {
  const trimmed = note.trim()

  return items.map(({ key: _key, ...draft }) => ({
    ...draft,
    ...(trimmed === '' ? {} : { note: trimmed }),
    id: '',
    status: 'pending',
  }))
}

/**
 * Put `text` on the clipboard. Resolves to whether it got there.
 *
 * **Never throws.** A failed copy is an ordinary outcome the caller reports in the badge — the
 * batch is untouched either way, so there is nothing to recover and nothing to unwind.
 *
 * **The two paths are chosen by feature detection, not by catching a rejection, and that
 * ordering is load-bearing.** `document.execCommand('copy')` requires transient user
 * activation. Awaiting `navigator.clipboard.writeText` and falling back on rejection can land
 * the fallback in a later task, by which point the activation from the keypress is gone and the
 * fallback fails too. So the case D4's acceptance criteria actually name — a non-secure origin,
 * i.e. a dev server reached over a LAN IP rather than localhost, which F3's host list permits —
 * is detected up front and handled in the same task as the keydown. A *rejection* still falls
 * through, but that path is genuinely best-effort.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied, or a browser that exposes the API and refuses to use it. Fall
      // through — see the activation note above for why this arm is the weaker one.
    }
  }

  return copyViaTextarea(text)
}

/**
 * The pre-async-clipboard path, and the one D4's third criterion is about.
 *
 * A `<textarea>` rather than a selected `<span>`: an element the user can select is the only
 * thing `execCommand('copy')` reliably reads across browsers, and a textarea preserves the
 * block's newlines and leading spaces verbatim where a text node's selection does not.
 *
 * Appended to `document.documentElement` rather than `document.body`, for the reason
 * ./overlay.ts gives: it keeps `document.body.innerHTML` snapshots clean, and it works on a
 * page whose body has not been parsed yet.
 *
 * **This moves focus**, unavoidably — selecting a textarea requires focusing it. What was
 * focused before is restored below, which covers the app's own fields. It cannot cover a field
 * inside dogear's closed shadow root, where `document.activeElement` reports the host: that
 * restoration is ./session.ts's, which is the only place with a handle on the box.
 */
function copyViaTextarea(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false

  const active = document.activeElement
  const selection = document.getSelection()
  const previous =
    selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  const field = document.createElement('textarea')
  field.value = text
  // Off-screen without being `hidden` or `display: none`, either of which makes the element
  // unselectable and the copy a silent no-op. `position: fixed` keeps it out of layout so
  // appending it cannot shift the page, and a negative offset would risk a scroll jump.
  field.setAttribute(
    'style',
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;' +
      'outline:none;box-shadow:none;background:transparent;opacity:0;',
  )
  field.setAttribute('aria-hidden', 'true')
  field.tabIndex = -1

  try {
    document.documentElement.append(field)
    field.focus()
    field.select()

    // Explicit range as well as `select()`: iOS Safari ignores the latter on a
    // programmatically focused field. Supplementary rather than required — hence its own
    // guard, so an engine without it cannot take down a copy `select()` had already set up.
    try {
      field.setSelectionRange(0, text.length)
    } catch {
      // The selection `select()` made stands.
    }

    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()

    // Best-effort, and in its own guard: a partial `Selection` implementation must not be able
    // to fail a copy that already succeeded.
    try {
      if (previous !== null && selection !== null) {
        selection.removeAllRanges()
        selection.addRange(previous)
      }
      if (active instanceof HTMLElement) active.focus()
    } catch {
      // Nothing to do, and nothing worth saying — the text is on the clipboard either way.
    }
  }
}
