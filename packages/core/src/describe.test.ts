// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

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
    expect(describeElement(element(html))).toEqual(expected)
  })

  it('caps text at 80 characters and marks the truncation', () => {
    const long = 'x'.repeat(200)

    const { text } = describeElement(element(`<p>${long}</p>`))

    expect(text).toHaveLength(81)
    expect(text.endsWith('…')).toBe(true)
  })
})

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
    expect(labelFor(description)).toBe(expected)
  })
})
