// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'

import type { SourceSite } from './sites.js'
import {
  COMPONENT_ATTRIBUTE,
  collectSites,
  MAX_SITES,
  SOURCE_ATTRIBUTE,
} from './sites.js'

/**
 * C2's (#16) two acceptance criteria and the rules underneath them.
 *
 * happy-dom rather than the node environment, because the whole of `collectSites` is a DOM
 * walk — but no layout is involved, so this suite is unaffected by the missing layout engine
 * that keeps ./box.ts's geometry in the node environment.
 *
 * The trees are built from markup rather than by hand-assembling elements: the nesting *is*
 * the fixture here, and a chain of `appendChild` calls hides the one thing each case is
 * about.
 */

afterEach(() => {
  document.body.innerHTML = ''
})

/** Mount `html` and return the element carrying `id="target"`. */
function mount(html: string): Element {
  document.body.innerHTML = html

  const target = document.getElementById('target')
  if (target === null) throw new Error('fixture has no #target')

  return target
}

/** `file:line:col` per site, which is what every ordering assertion is really about. */
function locations(sites: readonly SourceSite[]): string[] {
  return sites.map((site) => `${site.file}:${site.line}:${site.column}`)
}

describe('collectSites', () => {
  it('starts at the clicked element itself, not its parent', () => {
    const target = mount(`
      <div ${SOURCE_ATTRIBUTE}="src/App.tsx:5:3">
        <button id="target" ${SOURCE_ATTRIBUTE}="src/Button.tsx:20:5"></button>
      </div>
    `)

    // `closest()` semantics, as the brief specifies. An implementation that walked from
    // parentElement would still return App.tsx and still look nearest-first.
    expect(locations(collectSites(target))[0]).toBe('src/Button.tsx:20:5')
  })

  it('orders the chain nearest-first', () => {
    const target = mount(`
      <main ${SOURCE_ATTRIBUTE}="src/App.tsx:27:5">
        <nav ${SOURCE_ATTRIBUTE}="src/TabBar.tsx:22:5">
          <button id="target" ${SOURCE_ATTRIBUTE}="src/Button.tsx:20:5"></button>
        </nav>
      </main>
    `)

    expect(locations(collectSites(target))).toEqual([
      'src/Button.tsx:20:5',
      'src/TabBar.tsx:22:5',
      'src/App.tsx:27:5',
    ])
  })

  it('spans component boundaries — both Button.tsx and TabBar.tsx appear', () => {
    // The ticket's second criterion, stated in its own terms. The `<Button/>` call site is
    // never stamped — the transform touches host elements only — so TabBar contributes the
    // `<nav>` that wraps the button. The criterion is that the file is there.
    const target = mount(`
      <nav ${SOURCE_ATTRIBUTE}="src/TabBar.tsx:22:5" ${COMPONENT_ATTRIBUTE}="TabBar">
        <button id="target" ${SOURCE_ATTRIBUTE}="src/Button.tsx:20:5" ${COMPONENT_ATTRIBUTE}="Button"></button>
      </nav>
    `)

    const files = collectSites(target).map((site) => site.file)
    expect(files).toContain('src/Button.tsx')
    expect(files).toContain('src/TabBar.tsx')
  })

  it('skips ancestors that carry no stamp', () => {
    const target = mount(`
      <main ${SOURCE_ATTRIBUTE}="src/App.tsx:27:5">
        <div class="unstamped">
          <span id="target"></span>
        </div>
      </main>
    `)

    expect(locations(collectSites(target))).toEqual(['src/App.tsx:27:5'])
  })

  it('returns an empty array when nothing in the chain is stamped', () => {
    // A third-party component, a portal, a `.js` file, or the transform switched off. An
    // ordinary outcome, not an error — C3's (#17) floor is what keeps the item useful.
    const target = mount('<div><span id="target"></span></div>')

    expect(collectSites(target)).toEqual([])
  })
})

describe('deduplication', () => {
  it('keeps one site per file, the nearest occurrence winning', () => {
    // The example app's filler paragraphs in miniature: three stamped ancestors, one file.
    const target = mount(`
      <main ${SOURCE_ATTRIBUTE}="src/App.tsx:27:5">
        <section ${SOURCE_ATTRIBUTE}="src/App.tsx:67:7">
          <p id="target" ${SOURCE_ATTRIBUTE}="src/App.tsx:74:9"></p>
        </section>
      </main>
    `)

    expect(locations(collectSites(target))).toEqual(['src/App.tsx:74:9'])
  })

  it('still reaches an outer file that repeated wrappers would have buried', () => {
    // The reason dedup happens before the cap. Six stamped ancestors inside Button.tsx would
    // exhaust MAX_SITES on their own, and TabBar — the location the ticket exists to deliver
    // — would never appear.
    const wrappers = Array.from(
      { length: 6 },
      (_, index) => `<div ${SOURCE_ATTRIBUTE}="src/Button.tsx:${30 - index}:3">`,
    ).join('')

    const target = mount(`
      <nav ${SOURCE_ATTRIBUTE}="src/TabBar.tsx:22:5">
        ${wrappers}
          <button id="target" ${SOURCE_ATTRIBUTE}="src/Button.tsx:20:5"></button>
        ${'</div>'.repeat(6)}
      </nav>
    `)

    expect(locations(collectSites(target))).toEqual([
      'src/Button.tsx:20:5',
      'src/TabBar.tsx:22:5',
    ])
  })

  it(`caps at ${String(MAX_SITES)} distinct files`, () => {
    const files = Array.from({ length: MAX_SITES + 3 }, (_, index) => `src/L${index}.tsx`)

    // Outermost first, so the innermost element is the last file in the list.
    const open = files.map((file) => `<div ${SOURCE_ATTRIBUTE}="${file}:1:1">`).join('')
    const target = mount(
      `${open}<span id="target"></span>${'</div>'.repeat(files.length)}`,
    )

    const sites = collectSites(target)
    expect(sites).toHaveLength(MAX_SITES)
    // Nearest-first, so the cap drops the outermost files rather than the nearest ones.
    expect(sites.map((site) => site.file)).toEqual(
      [...files].reverse().slice(0, MAX_SITES),
    )
  })
})

describe('the site payload', () => {
  it('carries the tag lowercased and via: attribute', () => {
    const target = mount(
      `<button id="target" ${SOURCE_ATTRIBUTE}="src/Button.tsx:20:5"></button>`,
    )

    expect(collectSites(target)[0]).toEqual({
      file: 'src/Button.tsx',
      line: 20,
      column: 5,
      tag: 'button',
      via: 'attribute',
    })
  })

  it("reads C5's component name where the transform stamped one", () => {
    const target = mount(
      `<button id="target" ${SOURCE_ATTRIBUTE}="src/Button.tsx:20:5" ${COMPONENT_ATTRIBUTE}="Button"></button>`,
    )

    expect(collectSites(target)[0]?.component).toBe('Button')
  })

  it('omits the component key entirely rather than sending undefined', () => {
    // `format.ts` renders the trailing `(Button)` only when the key is there, and an element
    // outside any component boundary legitimately has no name.
    const target = mount(`<div id="target" ${SOURCE_ATTRIBUTE}="src/App.tsx:5:3"></div>`)

    expect(collectSites(target)[0]).not.toHaveProperty('component')
  })

  it('treats an empty component attribute as absent', () => {
    const target = mount(
      `<div id="target" ${SOURCE_ATTRIBUTE}="src/App.tsx:5:3" ${COMPONENT_ATTRIBUTE}=""></div>`,
    )

    expect(collectSites(target)[0]).not.toHaveProperty('component')
  })
})

describe('malformed stamps', () => {
  const cases: readonly { readonly name: string; readonly value: string }[] = [
    { name: 'no position at all', value: 'src/App.tsx' },
    { name: 'only one position', value: 'src/App.tsx:12' },
    { name: 'a non-numeric line', value: 'src/App.tsx:abc:5' },
    { name: 'a non-numeric column', value: 'src/App.tsx:12:abc' },
    { name: 'a partly-numeric position', value: 'src/App.tsx:12abc:5' },
    { name: 'a zero line', value: 'src/App.tsx:0:5' },
    { name: 'a negative line', value: 'src/App.tsx:-3:5' },
    { name: 'a fractional line', value: 'src/App.tsx:1.5:5' },
    { name: 'an empty file', value: ':12:5' },
    { name: 'an empty value', value: '' },
    { name: 'empty positions', value: 'src/App.tsx::' },
  ]

  it.each(cases)('drops an ancestor stamped with $name', ({ value }) => {
    const target = mount(`
      <main ${SOURCE_ATTRIBUTE}="src/App.tsx:27:5">
        <div id="target" ${SOURCE_ATTRIBUTE}="${value}"></div>
      </main>
    `)

    // Silently: the bad ancestor is dropped, the rest of the chain survives, and nothing is
    // thrown into a page-load-time dev tool.
    expect(locations(collectSites(target))).toEqual(['src/App.tsx:27:5'])
  })

  it('keeps a path containing a colon by splitting from the right', () => {
    const target = mount(
      `<div id="target" ${SOURCE_ATTRIBUTE}="src/a:b/App.tsx:12:5"></div>`,
    )

    expect(collectSites(target)[0]?.file).toBe('src/a:b/App.tsx')
  })
})

describe('shadow DOM', () => {
  it('hops out of a shadow root and keeps walking', () => {
    const host = mount(`
      <main ${SOURCE_ATTRIBUTE}="src/App.tsx:27:5">
        <div id="target" ${SOURCE_ATTRIBUTE}="src/Widget.tsx:10:3"></div>
      </main>
    `)

    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `<button ${SOURCE_ATTRIBUTE}="src/Inner.tsx:4:5"></button>`

    const inner = root.querySelector('button')
    if (inner === null) throw new Error('fixture has no shadow button')

    // Without the hop the chain would stop at Inner.tsx, and a truncated chain is
    // indistinguishable from an exhausted one at the call site.
    expect(locations(collectSites(inner))).toEqual([
      'src/Inner.tsx:4:5',
      'src/Widget.tsx:10:3',
      'src/App.tsx:27:5',
    ])
  })
})
