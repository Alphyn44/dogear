import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'

import type { StoredAnnotation } from '@dogear/queue'

/**
 * Staleness — D5 (#24).
 *
 * **Derived here, never stored.** `status` is `pending | resolved` and nothing else; an item
 * whose text has vanished is still pending, just flagged. A stored flag would go out of date
 * the moment someone re-added the snippet. See the brief's Decisions log.
 *
 * This module owns every line that touches the filesystem, and {@link formatQueue} owns every
 * line that renders. That split is not tidiness: D4's clipboard export runs the same formatter
 * in a *browser*, which has no `node:fs` and no repository. It passes no set and renders no
 * markers, and nothing has to be unpicked first.
 *
 * ## Why this is not `file.includes(text)`
 *
 * The brief's criterion — "the text snippet no longer appears in its named file" — flags every
 * checkable item in a real queue, for four reasons found on this repo's own example app:
 *
 * - **The text lives at the call site.** dogear's whole premise is that the innermost site is
 *   the component's own file, so `Button.tsx` holds `{label}` while the string "Overview" is
 *   at `App.tsx`. Checking only the primary site flags every component-authored element in a
 *   component-based UI — the exact case dogear exists for.
 * - **CSS transforms the text.** `innerText` respects `text-transform`, so a source reading
 *   `Click log` is captured as `CLICK LOG`.
 * - **JSX interpolates.** Source `Paragraph {index + 1}.` renders as `Paragraph 1.`, so no
 *   whole-snippet comparison can ever succeed.
 * - **Source wraps, snippets do not.** `describe.ts` collapses whitespace before capping; the
 *   file it came from is indented and hard-wrapped.
 *
 * ## The failure direction that matters
 *
 * A **false stale** tells the agent to distrust a correct line number on every prompt, which
 * teaches everyone to ignore the marker — the feature becomes worse than absent. A **false
 * fresh** is the status quo: a wrong line number goes unflagged, and the item still carries
 * three other anchors to recover from. So every ambiguity below resolves toward *fresh*.
 */

/**
 * How many consecutive words must survive for an item to count as fresh.
 *
 * Only relevant to snippets *longer* than this that also contain an interpolation — short
 * static labels ("Overview", "Click log") take the whole-snippet path below and never see it.
 * What it really measures is how long a static run the matcher demands: too small and a
 * generic run like "the comment box should" matches unrelated markup, too large and a sentence
 * broken by two interpolations is flagged wrongly. Five is the middle of a narrow band; the
 * tests are table-driven around it, so moving it is a one-line experiment.
 */
const WINDOW = 5

/**
 * Files past this are not read.
 *
 * `sites[].file` only ever names JSX the transform stamped, so this should never fire. It is
 * here because the hook runs on every prompt the user types under a 10s ceiling, and one
 * hand-edited path pointing at a bundle should cost nothing. Over the cap reads as *could not
 * check*, never as evidence.
 */
const MAX_BYTES = 2 * 1024 * 1024

type FileRead =
  | { readonly kind: 'text'; readonly normalized: string }
  /** The file is gone. Evidence — this is the rename-or-delete case. */
  | { readonly kind: 'missing' }
  /** Present but unusable. **Not** evidence; see the failure-direction note above. */
  | { readonly kind: 'unreadable' }

/**
 * The ids of items whose text can no longer be found in any file they name.
 *
 * Ids rather than decorated annotations, so the caller decides what to do with them — the hook
 * renders a marker, `dogear_pending` also sets a field in its structured output, and neither
 * needs the other's shape.
 */
export function findStale(
  items: readonly StoredAnnotation[],
  gitRoot: string,
): ReadonlySet<string> {
  // One cache per call, never across calls. The queue is re-read on every prompt precisely
  // because the files underneath it change; a cache that outlived the call would answer from
  // the source tree as it was when the process started. Within one call it matters — eight
  // items naming three sites each is two dozen reads of perhaps four distinct files.
  const cache = new Map<string, FileRead>()
  const stale = new Set<string>()

  for (const item of items) {
    const text = textOf(item)
    const files = filesOf(item)

    // Nothing to compare, or nowhere to compare it. Not stale: the item may be perfectly
    // good, and this is the "could not check" case rather than a verdict.
    if (text === undefined || files.length === 0) continue

    let checked = false
    let confirmed = false

    for (const file of files) {
      const read = readOnce(cache, gitRoot, file)
      if (read.kind === 'unreadable') continue

      checked = true
      if (read.kind === 'text' && appearsIn(text, read.normalized)) {
        confirmed = true
        break
      }
    }

    if (checked && !confirmed) stale.add(item.id)
  }

  return stale
}

/**
 * Does the snippet still look like it came from this file?
 *
 * Exported for the tests, which cover the matcher far more densely than the traversal above.
 * `normalizedFile` is expected to have been through {@link normalize} already.
 */
export function appearsIn(snippet: string, normalizedFile: string): boolean {
  const needle = normalize(snippet)
  if (needle === '') return true

  const words = needle.split(' ')

  // Short enough to be a label rather than a sentence. Windowing here would be meaningless —
  // a one-word window matches almost any file — so the whole thing has to appear.
  if (words.length <= WINDOW) return normalizedFile.includes(needle)

  for (let start = 0; start + WINDOW <= words.length; start += 1) {
    if (normalizedFile.includes(words.slice(start, start + WINDOW).join(' '))) return true
  }

  return false
}

/**
 * Lowercased, whitespace collapsed.
 *
 * Both halves of the comparison go through this. Lowercasing is what survives
 * `text-transform: uppercase`; collapsing is what survives a snippet whose source is indented
 * and hard-wrapped across lines, since `describe.ts` already collapsed the captured side.
 */
export function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function readOnce(cache: Map<string, FileRead>, gitRoot: string, file: string): FileRead {
  const cached = cache.get(file)
  if (cached !== undefined) return cached

  const read = readFile(gitRoot, file)
  cache.set(file, read)
  return read
}

function readFile(gitRoot: string, file: string): FileRead {
  const root = resolvePath(gitRoot)
  const full = resolvePath(root, file)

  // `sites[].file` is git-root-relative by contract, but the queue is a file people edit by
  // hand and the hook runs unattended on every prompt. A `..` that escaped the repo would
  // turn a comment on a button into an arbitrary file read.
  if (full !== root && !full.startsWith(`${root}${sep}`)) return { kind: 'unreadable' }

  try {
    if (!existsSync(full)) return { kind: 'missing' }
    if (statSync(full).size > MAX_BYTES) return { kind: 'unreadable' }

    return { kind: 'text', normalized: normalize(readFileSync(full, 'utf8')) }
  } catch {
    // Permissions, a lock, a directory where a file was expected. Deliberately swallowed and
    // deliberately *not* evidence — see the failure-direction note in the header.
    return { kind: 'unreadable' }
  }
}

/** `element.text` — the re-anchoring lifeline, and the only field worth comparing. */
function textOf(item: StoredAnnotation): string | undefined {
  const element = asRecord(item['element'])
  if (element === undefined) return undefined

  const text = element['text']
  return typeof text === 'string' && text.trim() !== '' ? text : undefined
}

/**
 * Every file the item names, deduplicated, nearest first.
 *
 * All of them, not just the primary. An item is stale only when its text is in none of them —
 * which is what stops `Button.tsx` holding `{label}` from condemning an annotation whose text
 * is alive and well at the call site two frames up.
 */
function filesOf(item: StoredAnnotation): readonly string[] {
  const sites = Array.isArray(item['sites']) ? item['sites'] : []
  const files: string[] = []

  for (const site of sites) {
    const record = asRecord(site)
    const file = record?.['file']
    if (typeof file === 'string' && file !== '' && !files.includes(file)) files.push(file)
  }

  return files
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}
