import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { StoredAnnotation } from 'dogear-queue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appearsIn, findStale, normalize } from './stale.js'

/**
 * D5 (#24) — staleness, derived from the working tree.
 *
 * The suite is in three parts, and the middle one is the point of the ticket. `appearsIn`
 * covers the matcher densely because it is the only part with a tuning constant in it;
 * `findStale` covers the traversal and the read outcomes; and the regression block pins the
 * three shapes that made a literal `file.includes(text)` unusable, seeded verbatim from this
 * repo's own example app. Without that block, "simplifying" the matcher back to a substring
 * test looks harmless and passes everything else here.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-stale-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(relative: string, contents: string): void {
  const full = join(root, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

/** An annotation carrying only what staleness looks at: an id, a text, and some sites. */
function item(
  id: string,
  text: string | undefined,
  ...files: readonly string[]
): StoredAnnotation {
  return {
    id,
    status: 'pending',
    comment: 'a comment',
    ...(text === undefined ? {} : { element: { text } }),
    sites: files.map((file) => ({ file, line: 1 })),
  } as StoredAnnotation
}

function staleIds(...items: readonly StoredAnnotation[]): readonly string[] {
  return [...findStale(items, root)]
}

describe('normalize()', () => {
  it.each([
    {
      why: 'lowercases, so text-transform cannot lie',
      input: 'CLICK LOG',
      want: 'click log',
    },
    { why: 'collapses runs of whitespace', input: 'a\n   b\t\tc', want: 'a b c' },
    { why: 'trims the ends', input: '  padded  ', want: 'padded' },
    { why: 'leaves an empty string empty', input: '   \n ', want: '' },
  ])('$why', ({ input, want }) => {
    expect(normalize(input)).toBe(want)
  })
})

describe('appearsIn()', () => {
  const FILE = normalize(`
    <p>
      Paragraph {index + 1}. Alt-click any of these and the comment box should
      anchor below it — or flip above it, near the bottom of the viewport.
    </p>
  `)

  it.each([
    {
      why: 'an interpolation early in the sentence leaves a long static tail',
      snippet:
        'Paragraph 1. Alt-click any of these and the comment box should anchor below it —',
      want: true,
    },
    {
      why: 'source wrapping is invisible once both sides are collapsed',
      snippet: 'the comment box should anchor below it',
      want: true,
    },
    {
      why: 'a sentence that never existed here shares no five-word run',
      snippet: 'Completely different words that were never written in this file at all',
      want: false,
    },
  ])('$why', ({ snippet, want }) => {
    expect(appearsIn(snippet, FILE)).toBe(want)
  })

  it.each([
    { why: 'one word', snippet: 'overview', want: true },
    { why: 'exactly the window length', snippet: 'one two three four five', want: true },
    { why: 'one word, absent', snippet: 'nowhere', want: false },
    {
      why: 'at the window length with one word changed, via the fallback',
      snippet: 'one two three four six',
      want: true,
    },
  ])('a short snippet tries WHOLE first — $why', ({ snippet, want }) => {
    const file = normalize('const items = ["Overview"]; // one two three four five')
    expect(appearsIn(snippet, file)).toBe(want)
  })

  /**
   * G3 (#44). The rule used to be "short snippets must match whole", on the grounds that a
   * short label is a static one and windowing it would degrade to matching a single word
   * against the whole file. The first half of that does not hold: `Count is {count}` renders
   * as `Count is 0`, which is three words and interpolated, so it took the whole-snippet path
   * and could never satisfy it. A stock `npm create vite` counter button was flagged stale
   * against an untouched file.
   */
  describe('a short snippet that is interpolated rather than static', () => {
    const COUNTER = normalize(
      '<button type="button" className="counter" onClick={...}>Count is {count}</button>',
    )

    it('is fresh on the static run either side of the interpolation', () => {
      expect(appearsIn('Count is 0', COUNTER)).toBe(true)
    })

    it('is fresh however the interpolated value renders', () => {
      expect(appearsIn('Count is 41', COUNTER)).toBe(true)
    })

    it('still flags a short snippet that shares no run with the file', () => {
      expect(appearsIn('Submit the form', COUNTER)).toBe(false)
    })

    it('gives two words and fewer no fallback at all', () => {
      // `words.length - 1` is 1 there, and FLOOR refuses it — otherwise a genuinely vanished
      // two-word label would be rescued by whichever of its words survived elsewhere. `count`
      // is very much still in this file, and that is the whole point: the pair is not.
      expect(appearsIn('Count gone', COUNTER)).toBe(false)
      expect(appearsIn('Vanished', COUNTER)).toBe(false)
    })

    it('does not let a single surviving word carry a three-word snippet', () => {
      expect(appearsIn('count the beans', COUNTER)).toBe(false)
    })
  })

  it('a LONGER snippet needs only a window, not the whole thing', () => {
    // Six words: one past the window, so the first five carry it even though the last word
    // was never in the file.
    expect(
      appearsIn('one two three four five sixteen', normalize('one two three four five')),
    ).toBe(true)
  })

  it('slides the window rather than only testing the head', () => {
    // The failure this catches is an off-by-one that only ever checks words 0..4 — which
    // would flag every snippet whose divergence is at the front, the commonest interpolation
    // position of all.
    expect(
      appearsIn(
        'Paragraph 1. alt-click any of these and',
        normalize('alt-click any of these and'),
      ),
    ).toBe(true)
  })

  it('treats an empty snippet as confirming, never as evidence', () => {
    expect(appearsIn('   ', normalize('anything'))).toBe(true)
  })
})

describe('findStale()', () => {
  it('flags an item whose text is in none of its files', () => {
    write('src/Gone.tsx', 'export const Gone = () => <p>something else entirely</p>')

    expect(staleIds(item('a', 'the text that used to be here', 'src/Gone.tsx'))).toEqual([
      'a',
    ])
  })

  it('does NOT flag an item found in a later site — the call-site case', () => {
    // The one that matters most. The primary site is the component's own file and holds an
    // interpolation; the text lives two frames up at the call site. Checking only the primary
    // would condemn a perfectly good annotation.
    write(
      'src/Button.tsx',
      'export function Button({ label }) { return <button>{label}</button> }',
    )
    write('src/App.tsx', "const items = ['Overview', 'Settings']")

    expect(staleIds(item('a', 'Overview', 'src/Button.tsx', 'src/App.tsx'))).toEqual([])
  })

  it.each([
    {
      why: 'no element.text to compare',
      built: () => item('a', undefined, 'src/App.tsx'),
    },
    { why: 'no sites to compare against', built: () => item('a', 'anything') },
    { why: 'an empty text', built: () => item('a', '   ', 'src/App.tsx') },
  ])('never flags an item it could not check — $why', ({ built }) => {
    write('src/App.tsx', 'nothing relevant')

    expect(staleIds(built())).toEqual([])
  })

  it('treats a MISSING file as evidence — the rename-or-delete case', () => {
    // The strongest signal available, and the reason this is not lumped in with "unreadable".
    expect(staleIds(item('a', 'anything at all', 'src/Deleted.tsx'))).toEqual(['a'])
  })

  it('does NOT treat an unreadable path as evidence', () => {
    // A directory where a file was expected stands in for permissions and locks, which are
    // awkward to create portably. All three are "could not check", never a verdict.
    mkdirSync(join(root, 'src', 'NotAFile.tsx'), { recursive: true })

    expect(staleIds(item('a', 'anything at all', 'src/NotAFile.tsx'))).toEqual([])
  })

  it('refuses to read outside the git root, and does not call that evidence', () => {
    // A hand-edited queue must not be able to turn the hook into an arbitrary file reader.
    // Escaping resolves to "could not check", so the item is also not flagged.
    expect(staleIds(item('a', 'root:x:0:0', '../../../../../../etc/passwd'))).toEqual([])
  })

  it('checks a missing file but keeps looking, so a later site can still confirm', () => {
    write('src/App.tsx', 'const label = "Save changes"')

    expect(staleIds(item('a', 'Save changes', 'src/Deleted.tsx', 'src/App.tsx'))).toEqual(
      [],
    )
  })

  it('reads each distinct file once, however many items name it', () => {
    // Eight items naming three sites each is two dozen reads of a handful of files, on every
    // prompt the user types. Asserted through behaviour rather than a spy: if the cache were
    // keyed wrongly the results themselves would diverge.
    write('src/App.tsx', 'const items = ["Overview"]')

    const items = Array.from({ length: 8 }, (_, index) =>
      item(`item-${String(index)}`, 'Overview', 'src/App.tsx', 'src/App.tsx'),
    )

    expect(staleIds(...items)).toEqual([])
  })

  it('returns the ids of exactly the stale items, leaving the rest out', () => {
    write('src/App.tsx', 'const items = ["Overview"]')

    expect(
      staleIds(
        item('fresh', 'Overview', 'src/App.tsx'),
        item('gone', 'a string nowhere in that file', 'src/App.tsx'),
        item('unknowable', undefined, 'src/App.tsx'),
      ),
    ).toEqual(['gone'])
  })
})

describe('the three shapes that broke a literal match', () => {
  /**
   * Seeded verbatim from examples/react-app. Each of these is fresh — the annotation is
   * correct and the element is still there — and each would be flagged stale by
   * `file.includes(text)`. If this block ever goes red, the matcher has regressed to
   * something that will mark a healthy queue stale on every prompt.
   */
  beforeEach(() => {
    write(
      'src/Button.tsx',
      `export function Button({ label, onClick }: ButtonProps) {
         return (
           <button className="tab" type="button" onClick={onClick}>
             {label}
           </button>
         )
       }`,
    )
    write(
      'src/App.tsx',
      `const items = ['Overview', 'Settings', 'Billing']

       <h2 data-testid="log-heading">Click log</h2>

       {Array.from({ length: 12 }, (_, index) => (
         <p key={index}>
           Paragraph {index + 1}. Alt-click any of these and the comment box should
           anchor below it — or flip above it, near the bottom of the viewport.
         </p>
       ))}`,
    )
  })

  it.each([
    {
      why: 'text lives at the CALL SITE, not in the component that renders it',
      text: 'Overview',
      files: ['src/Button.tsx', 'src/App.tsx'],
    },
    {
      why: 'CSS text-transform uppercased what innerText captured',
      text: 'CLICK LOG',
      files: ['src/App.tsx'],
    },
    {
      why: 'JSX interpolated a value into the middle of the sentence',
      text: 'Paragraph 1. Alt-click any of these and the comment box should anchor below it —',
      files: ['src/App.tsx'],
    },
  ])('stays FRESH when $why', ({ text, files }) => {
    expect(staleIds(item('a', text, ...files))).toEqual([])
  })

  it('still flags a genuinely departed element in the same files', () => {
    // The other half. A matcher loose enough to pass the three above must not pass everything
    // — otherwise the feature is decorative.
    expect(
      staleIds(item('a', 'Archived invoices from last quarter', 'src/App.tsx')),
    ).toEqual(['a'])
  })
})
