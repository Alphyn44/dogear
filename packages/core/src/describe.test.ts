// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import type { ElementDescription } from './describe.js'
import { describeElement, labelFor } from './describe.js'

function element(html: string): Element {
  const container = document.createElement('div')
  container.innerHTML = html
  const first = container.firstElementChild
  if (first === null) throw new Error(`fixture produced no element: ${html}`)
  return first
}

describe('describeElement', () => {
  it.each([
    {
      html: '<button class="tab" type="button">Settings</button>',
      expected: { tag: 'button', id: null, classes: ['tab'], text: 'Settings' },
      why: 'the ordinary case, and the one in examples/react-app',
    },
    {
      html: '<div id="root" class="a b">hi</div>',
      expected: { tag: 'div', id: 'root', classes: ['a', 'b'], text: 'hi' },
      why: 'classList is already tokenised, so multiple classes need no splitting',
    },
    {
      html: '<div id="">x</div>',
      expected: { tag: 'div', id: null, classes: [], text: 'x' },
      why: 'id="" is legal HTML and means the same as absent to anyone reading a label',
    },
    {
      html: '<SPAN>Hi</SPAN>',
      expected: { tag: 'span', id: null, classes: [], text: 'Hi' },
      why: 'tagName is uppercase for HTML elements; the payload is lowercase',
    },
    {
      html: '<div>   lots\n   of\t whitespace   </div>',
      expected: { tag: 'div', id: null, classes: [], text: 'lots of whitespace' },
      why: 'collapsed before capping, so 80 characters means 80 readable ones',
    },
    {
      html: '<div></div>',
      expected: { tag: 'div', id: null, classes: [], text: '' },
      why: 'an empty element still describes — element is never null, per C3',
    },
  ])('$why', ({ html, expected }) => {
    // `expect.any(String)` for the selector rather than a literal: ./selector.test.ts owns
    // what it contains, and pinning the text here would make every improvement to the
    // segment heuristic break a test about `describeElement`. `toEqual` still refuses an
    // unexpected extra field, which is the property this table is really guarding.
    expect(describeElement(element(html))).toEqual({
      ...expected,
      selector: expect.any(String) as unknown as string,
    })
  })

  it('carries a selector that finds the element again', () => {
    const target = element('<button class="tab">Settings</button>')

    const { selector } = describeElement(target)

    expect(selector).not.toBe('')
    expect(target.parentElement?.querySelector(selector)).toBe(target)
  })

  it('carries a test id where the element has one, and omits the key otherwise', () => {
    expect(describeElement(element('<b data-testid="save-btn">x</b>')).testId).toBe(
      'save-btn',
    )
    expect(describeElement(element('<b>x</b>'))).not.toHaveProperty('testId')
  })

  it('caps text at 80 characters and appends nothing', () => {
    // C3 inverted this. It used to assert 81 characters ending in `…`, back when `text` was
    // a label. It is a contract now: D5 marks an item stale by searching the named file for
    // this exact string, so a truncation marker would make every snippet past the cap
    // permanently unfindable — and therefore every long-text item permanently stale.
    // The ellipsis moved to `labelFor`, which is where a human reads it.
    const long = 'x'.repeat(200)

    const { text } = describeElement(element(`<p>${long}</p>`))

    expect(text).toHaveLength(80)
    expect(text).toBe('x'.repeat(80))
  })
})

/**
 * A description built by hand, for the label tests.
 *
 * `selector` is required on the payload and `labelFor` never reads it — the label is built
 * from tag, id and classes, deliberately, because a full selector is too long to sit above a
 * comment box. Defaulting it here keeps that fact visible instead of repeating a dummy
 * value on every row.
 */
function described(fields: Partial<ElementDescription>): ElementDescription {
  return { tag: 'div', selector: 'div', text: '', classes: [], id: null, ...fields }
}

describe('labelFor', () => {
  it.each([
    {
      description: { tag: 'button', id: null, classes: ['tab'], text: 'Settings' },
      expected: 'button.tab — "Settings"',
      why: 'the shape the comment box shows',
    },
    {
      description: { tag: 'div', id: 'root', classes: [], text: '' },
      expected: 'div#root',
      why: 'no text means no quoted half rather than an empty pair of quotes',
    },
    {
      description: { tag: 'nav', id: null, classes: [], text: 'Overview' },
      expected: 'nav — "Overview"',
      why: 'a bare tag is still a useful label',
    },
    {
      description: { tag: 'div', id: null, classes: ['a', 'b', 'c', 'd'], text: '' },
      expected: 'div.a.b…',
      why: 'a Tailwind element has forty classes; the label shows two and says so',
    },
  ])('$why', ({ description, expected }) => {
    expect(labelFor(described(description))).toBe(expected)
  })

  it('appends the ellipsis describeElement no longer does', () => {
    // The display half of C3's text change. The payload is undecorated so D5 can search for
    // it; the affordance that says "there was more" lives here, at the only place a human
    // reads it. Truncation is inferred from the length, since the description does not
    // record it — see labelFor's docblock for what that costs.
    const capped = described({ tag: 'p', text: 'x'.repeat(80) })

    expect(labelFor(capped)).toBe(`p — "${'x'.repeat(80)}…"`)
  })

  it('leaves a shorter text alone', () => {
    expect(labelFor(described({ tag: 'p', text: 'x'.repeat(79) }))).toBe(
      `p — "${'x'.repeat(79)}"`,
    )
  })
})
