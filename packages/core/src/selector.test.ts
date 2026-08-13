// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'

import { buildSelector, MAX_DEPTH, TEST_ID_ATTRIBUTES, testIdOf } from './selector.js'

/**
 * C3's (#17) selector floor.
 *
 * Almost every assertion here is written as a **round trip** — build a selector, then use it
 * to look the element back up — rather than as a string comparison. The exact text of a
 * selector is an implementation detail that a better segment heuristic should be free to
 * improve; what may never change is that it finds the element it was built from. The few
 * tests that do assert an exact string are the ones where the shape *is* the decision:
 * `:nth-of-type` over `:nth-child`, the bracket form for an unquotable id, and the test-id
 * fast path.
 */

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(html: string): void {
  document.body.innerHTML = html
}

/** The element a selector actually finds, so a test can assert identity rather than text. */
function resolve(selector: string): Element | null {
  return document.querySelector(selector)
}

describe('testIdOf', () => {
  it.each(TEST_ID_ATTRIBUTES)('reads %s', (attribute) => {
    mount(`<button ${attribute}="save-btn"></button>`)
    const element = document.querySelector('button')!

    expect(testIdOf(element)).toBe('save-btn')
  })

  it('prefers data-testid when an element carries several', () => {
    // First match wins, in the order the constant declares — data-testid is the React
    // Testing Library convention and by far the most common.
    mount('<button data-cy="cypress" data-testid="rtl" data-qa="qa"></button>')

    expect(testIdOf(document.querySelector('button')!)).toBe('rtl')
  })

  it('is undefined for an element with none, and for an empty one', () => {
    mount('<button></button><span data-testid=""></span>')

    expect(testIdOf(document.querySelector('button')!)).toBeUndefined()
    expect(testIdOf(document.querySelector('span')!)).toBeUndefined()
  })
})

describe('the fast paths', () => {
  it('uses the element’s own id', () => {
    mount('<main><button id="save"></button></main>')
    const element = document.querySelector('#save')!

    expect(buildSelector(element)).toBe('#save')
  })

  it('falls back to the bracket form for an id a selector cannot carry literally', () => {
    // `#2fa-panel` is not a valid selector — an identifier may not start with a digit — and
    // the bracket form avoids needing CSS.escape at all. See the module header.
    mount('<div id="2fa-panel"></div>')
    const element = document.querySelector('[id="2fa-panel"]')!

    expect(buildSelector(element)).toBe('[id="2fa-panel"]')
    expect(resolve(buildSelector(element))).toBe(element)
  })

  it('uses a test id when there is no id', () => {
    mount('<main><h2 data-testid="log-heading">Click log</h2></main>')
    const element = document.querySelector('h2')!

    expect(buildSelector(element)).toBe('[data-testid="log-heading"]')
  })

  it('names the attribute the element actually carries, not always data-testid', () => {
    mount('<main><button data-cy="clear"></button></main>')
    const element = document.querySelector('button')!

    expect(buildSelector(element)).toBe('[data-cy="clear"]')
    expect(resolve(buildSelector(element))).toBe(element)
  })

  it('escapes a quote in a test id rather than breaking out of the attribute', () => {
    mount(`<button data-testid='say "hi"'></button>`)
    const element = document.querySelector('button')!

    expect(resolve(buildSelector(element))).toBe(element)
  })

  it('does not take a fast path when the id is not actually unique', () => {
    // Duplicate ids are invalid HTML and entirely real. The identity check is what catches
    // it: `#dup` resolves to the first one, so for the second the walk has to continue.
    mount('<main><p id="dup">one</p><p id="dup">two</p></main>')
    const second = document.querySelectorAll('[id="dup"]')[1]!

    expect(resolve(buildSelector(second))).toBe(second)
  })
})

describe('the walk', () => {
  it('uses :nth-of-type, not :nth-child, to separate same-tag siblings', () => {
    // The decision the brief contradicts itself on. nth-of-type counts among same-tag
    // siblings, so the <h2> above the buttons does not shift them.
    mount(`
      <nav class="tab-bar">
        <h2>Tabs</h2>
        <button>Overview</button>
        <button>Settings</button>
      </nav>
    `)
    const settings = document.querySelectorAll('button')[1]!

    const selector = buildSelector(settings)
    expect(selector).toContain(':nth-of-type(2)')
    expect(selector).not.toContain('nth-child')
    expect(resolve(selector)).toBe(settings)
  })

  it('prefers a distinguishing class over counting', () => {
    // `nav.tab-bar` names the thing; `nav:nth-of-type(1)` only counts it.
    mount('<div><nav class="tab-bar"></nav><nav class="other"></nav></div>')
    const element = document.querySelector('.tab-bar')!

    expect(buildSelector(element)).toContain('.tab-bar')
    expect(resolve(buildSelector(element))).toBe(element)
  })

  it('ignores a class shared by every sibling, which distinguishes nothing', () => {
    mount('<ul><li class="row"></li><li class="row"></li><li class="row"></li></ul>')
    const second = document.querySelectorAll('li')[1]!

    expect(buildSelector(second)).toContain(':nth-of-type(2)')
    expect(resolve(buildSelector(second))).toBe(second)
  })

  it('climbs past a selector whose first match is the target but is not unique', () => {
    // The trap that first-match-only verification falls into. `button:nth-of-type(1)`
    // matches the aside's button *and* the nav's, and the aside comes first in document
    // order — so a check of "does querySelector find my element" passes while the selector
    // is one conditional sidebar away from silently meaning something else.
    mount(`
      <aside><button>side</button></aside>
      <nav><button>a</button><button>b</button></nav>
    `)
    const target = document.querySelector('aside button')!

    expect(document.querySelectorAll('button:nth-of-type(1)').length).toBeGreaterThan(1)

    const selector = buildSelector(target)
    expect(document.querySelectorAll(selector)).toHaveLength(1)
    expect(resolve(selector)).toBe(target)
  })

  it('stops as soon as the selector is unique rather than walking to the root', () => {
    mount(`
      <main><section><div><span><em class="deep">x</em></span></div></section></main>
    `)
    const element = document.querySelector('.deep')!

    // One segment is enough here — nothing else on the page is an `em.deep`.
    expect(buildSelector(element)).toBe('em.deep')
  })

  it('anchors on an ancestor id and stops climbing there', () => {
    // The identical subtree comes *first* on purpose. `querySelector` returns the earliest
    // match in document order, so putting the target second is what forces the walk to keep
    // climbing — with the order reversed, `p:nth-of-type(2)` alone would already be correct
    // and the id would never be reached.
    mount(`
      <div><main class="app"><p>one</p><p>two</p></main></div>
      <div id="root">
        <main class="app"><p>one</p><p>two</p></main>
      </div>
    `)
    const target = document.querySelector('#root p:nth-of-type(2)')!

    const selector = buildSelector(target)
    expect(selector.startsWith('#root >')).toBe(true)
    expect(resolve(selector)).toBe(target)
  })
})

describe('class filtering', () => {
  const rejected: readonly { readonly name: string; readonly why: string }[] = [
    { name: 'w-1/2', why: 'a Tailwind fraction needs escaping' },
    { name: 'hover:bg-blue-500', why: 'a Tailwind variant needs escaping' },
    { name: 'md:flex', why: 'a Tailwind breakpoint needs escaping' },
    {
      name: 'Button_tab__x7f3q',
      why: 'a CSS-modules hash will change on the next build',
    },
    { name: 'css-1q2w3e4', why: 'an emotion hash will change on the next build' },
  ]

  it.each(rejected)('never anchors on $name — $why', ({ name }) => {
    mount(`<div><span class="${name}">a</span><span>b</span></div>`)
    const element = document.querySelector('span')!

    const selector = buildSelector(element)
    expect(selector).not.toContain(name)
    // Still correct, just by position instead.
    expect(resolve(selector)).toBe(element)
  })

  const kept: readonly string[] = ['tab-bar', 'btn-primary', 'bg-blue-500', '_private']

  it.each(kept)('is happy to anchor on %s', (name) => {
    mount(`<div><span class="${name}">a</span><span>b</span></div>`)
    const element = document.querySelector('span')!

    expect(buildSelector(element)).toContain(`.${name}`)
  })
})

describe('the guarantees', () => {
  it('gives every element of a realistic page a selector that finds only it', () => {
    // The sweep. Individual cases above pin individual decisions; this asserts the property
    // the whole module exists for, against markup shaped like examples/react-app — repeated
    // siblings, shared classes, a test id, and two sections whose children collide by
    // position. Every failure mode this file tests for would show up here as a count of 0
    // or 2+, which is why it is worth having on top of the cases.
    mount(`
      <div id="root">
        <main class="app">
          <header class="masthead"><h1>dogear example</h1></header>
          <p>first</p>
          <p>second</p>
          <nav class="tab-bar">
            <button class="tab">Overview</button>
            <button class="tab">Settings</button>
            <button class="tab">Billing</button>
            <button class="tab">Clear</button>
          </nav>
          <section class="log">
            <h2 data-testid="log-heading">Click log</h2>
            <p class="empty">Nothing yet.</p>
          </section>
          <section class="filler"><p>a</p><p>b</p><p>c</p></section>
        </main>
      </div>
    `)

    const elements = [...document.body.querySelectorAll('*')]
    expect(elements.length).toBeGreaterThan(15)

    for (const element of elements) {
      const selector = buildSelector(element)
      const where = `<${element.tagName.toLowerCase()}> → ${selector}`

      expect(document.querySelectorAll(selector).length, where).toBe(1)
      expect(document.querySelector(selector), where).toBe(element)
    }
  })

  it('never returns an empty string, even for a detached element', () => {
    // "Regardless of framework, bundler, or resolution success" is the criterion, and a
    // detached node is the most degenerate input there is.
    const orphan = document.createElement('div')

    expect(buildSelector(orphan)).not.toBe('')
  })

  it('returns a best-effort path rather than failing when depth runs out', () => {
    // A ladder of identical divs far deeper than the cap, duplicated so no prefix is ever
    // unique. The result cannot resolve uniquely — the point is that it is still a string,
    // built from the segments the walk did manage.
    const ladder = (depth: number): string =>
      depth === 0 ? '<i>x</i>' : `<div>${ladder(depth - 1)}</div>`
    mount(
      `<section>${ladder(MAX_DEPTH + 4)}</section><section>${ladder(MAX_DEPTH + 4)}</section>`,
    )
    // The *second* ladder. Every candidate the walk builds matches the first one, so nothing
    // ever verifies and the depth cap is what ends it — which is the case under test.
    const element = document.querySelectorAll('i')[1]!

    const selector = buildSelector(element)
    expect(selector).not.toBe('')
    expect(selector.split(' > ')).toHaveLength(MAX_DEPTH)
  })

  it('resolves against the shadow root, not the document', () => {
    // A document-rooted querySelector can never see inside a shadow root, so verifying
    // against `document` would reject every correct answer and burn the whole depth budget.
    mount('<div id="host"></div>')
    const root = document.querySelector('#host')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<nav><button class="inner">go</button></nav>'
    const element = root.querySelector('.inner')!

    const selector = buildSelector(element)
    expect(root.querySelector(selector)).toBe(element)
    expect(document.querySelector(selector)).toBeNull()
  })
})
