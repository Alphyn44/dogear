import { describe, expect, it } from 'vitest'

import { isPaintable, outlineStyle } from './outline.js'

/**
 * The node environment, on purpose — no `@vitest-environment` docblock here.
 *
 * This is the mitigation for happy-dom having no layout engine. Everything a DOM test could
 * assert about the outline's position would be asserted against `getBoundingClientRect()`
 * returning zeros, which proves nothing. The arithmetic lives in pure functions precisely so
 * it can be tested against real numbers, with no DOM in the picture at all.
 */

describe('isPaintable', () => {
  it.each([
    {
      box: { x: 0, y: 0, width: 100, height: 20 },
      expected: true,
      why: 'an ordinary rect',
    },
    {
      box: { x: -50, y: -50, width: 100, height: 20 },
      expected: true,
      why: 'scrolled off the top of the viewport is still paintable — it is simply clipped',
    },
    {
      box: { x: 0, y: 0, width: 0, height: 20 },
      expected: false,
      why: 'zero width — an inline element that generated no boxes',
    },
    {
      box: { x: 0, y: 0, width: 100, height: 0 },
      expected: false,
      why: 'zero height — an empty block',
    },
    {
      box: { x: 0, y: 0, width: 0, height: 0 },
      expected: false,
      why: 'display:none, the case that would otherwise draw a dot in the corner',
    },
  ])('$expected for $why', ({ box, expected }) => {
    expect(isPaintable(box)).toBe(expected)
  })
})

describe('outlineStyle', () => {
  it.each([
    {
      box: { x: 10, y: 20, width: 100, height: 40 },
      expected: {
        transform: 'translate3d(10px, 20px, 0)',
        width: '100px',
        height: '40px',
      },
      why: 'integers pass through untouched',
    },
    {
      box: { x: 10.5, y: 20.25, width: 100.125, height: 40 },
      expected: {
        transform: 'translate3d(10.5px, 20.25px, 0)',
        width: '100.13px',
        height: '40px',
      },
      why: 'sub-pixel rects are real — they come from transforms and fractional font metrics',
    },
    {
      box: { x: 10.123456, y: 20.987654, width: 100, height: 40 },
      expected: {
        transform: 'translate3d(10.12px, 20.99px, 0)',
        width: '100px',
        height: '40px',
      },
      why: 'float noise is rounded away rather than serialised into the style attribute',
    },
    {
      box: { x: -120, y: -40, width: 100, height: 40 },
      expected: {
        transform: 'translate3d(-120px, -40px, 0)',
        width: '100px',
        height: '40px',
      },
      why: 'negative coordinates are correct for an element scrolled above the viewport',
    },
  ])('$why', ({ box, expected }) => {
    expect(outlineStyle(box)).toEqual(expected)
  })

  it('uses no scroll offset — the input is already viewport-relative', () => {
    // Pinning the decision rather than the arithmetic. getBoundingClientRect() and
    // position:fixed are both viewport-relative, so adding scrollY is the classic bug here.
    // If someone "fixes" that in, this fails.
    const box = { x: 0, y: 0, width: 10, height: 10 }

    expect(outlineStyle(box).transform).toBe('translate3d(0px, 0px, 0)')
  })
})
