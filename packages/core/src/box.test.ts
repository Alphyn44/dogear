import { describe, expect, it } from 'vitest'

import { anchorStyle, GAP } from './box.js'

/**
 * Node environment — same reasoning as ./outline.test.ts. happy-dom returns a zero rect for
 * everything, so the only place this arithmetic can be tested is here, against numbers.
 */

const VIEWPORT = { width: 1000, height: 800 }
const BOX = { width: 280, height: 120 }

describe('anchorStyle', () => {
  it.each([
    {
      target: { x: 100, y: 100, width: 200, height: 40 },
      expected: { left: '100px', top: `${100 + 40 + GAP}px` },
      why: 'below the target is the default — it does not cover what you just pointed at',
    },
    {
      target: { x: 100, y: 700, width: 200, height: 40 },
      expected: { left: '100px', top: `${700 - BOX.height - GAP}px` },
      why: 'flips above when below would overflow the bottom edge',
    },
    {
      target: { x: 100, y: 0, width: 200, height: 790 },
      expected: { left: '100px', top: `${800 - BOX.height - GAP}px` },
      why: 'a target filling the viewport fits neither above nor below, so the box clamps to the bottom-most fully visible position rather than going off-screen',
    },
    {
      target: { x: -40, y: 100, width: 200, height: 40 },
      expected: { left: `${GAP}px`, top: `${100 + 40 + GAP}px` },
      why: 'a target scrolled off the left edge must not drag the box off with it',
    },
    {
      target: { x: 960, y: 100, width: 200, height: 40 },
      expected: { left: `${1000 - BOX.width - GAP}px`, top: `${100 + 40 + GAP}px` },
      why: 'clamped against the right edge — the box stays fully visible',
    },
  ])('$why', ({ target, expected }) => {
    expect(anchorStyle(target, BOX, VIEWPORT)).toEqual(expected)
  })

  it('keeps a box wider than the viewport on screen rather than at a negative left', () => {
    // The guard this pins: `viewport.width - box.width - gap` goes negative here, and an
    // unclamped Math.min would pin the box off the *left* edge while trying to keep it off
    // the right. Narrow phone viewports make this reachable, not theoretical.
    const anchor = anchorStyle(
      { x: 10, y: 10, width: 50, height: 20 },
      { width: 400, height: 120 },
      { width: 320, height: 640 },
    )

    expect(anchor.left).toBe(`${GAP}px`)
  })

  it('honours a caller-supplied gap', () => {
    const anchor = anchorStyle({ x: 0, y: 0, width: 10, height: 10 }, BOX, VIEWPORT, 20)

    expect(anchor.top).toBe('30px')
  })
})
