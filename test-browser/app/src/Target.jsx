/**
 * H3 (#55) — the element the browser points at.
 *
 * **Exactly one button opening tag starts a line in this file, and the suite depends on it.**
 * `sourceLineOf` in ../../fixture.ts derives the expected `data-dogear-src` line by finding
 * that tag rather than by hard-coding a number, so editing this component moves the
 * expectation with it. It matches on the line's first characters precisely so that prose like
 * this sentence cannot collide with it — which it did, on the first run. A second button
 * element would still break it, and it would say so rather than asserting against the wrong
 * line: add elements below the counter, and keep them non-button.
 *
 * The counter is B1's other half, asserted here for the first time in a real browser: a
 * modifier-click must not reach the app's own handler. The suite reads this text before and
 * after the gesture and requires it not to have moved, then clicks *without* the modifier and
 * requires that it did — a one-sided assertion would pass on a page whose button was simply
 * broken.
 *
 * Inline styles rather than a stylesheet: the box has to be comfortably large (a real pointer
 * event needs a real target) and nowhere near the bottom-right corner, where dogear's badge
 * lives at `right: 12px; bottom: 12px`. Stating that here keeps the geometry the test relies
 * on in the file the test reads.
 */

import { useState } from 'react'

export function Target() {
  const [clicks, setClicks] = useState(0)

  return (
    <main style={{ font: '16px system-ui, sans-serif', margin: 0, padding: '40px' }}>
      <h1>dogear browser fixture</h1>
      <button
        type="button"
        style={{ padding: '32px 56px', fontSize: '20px', cursor: 'pointer' }}
        onClick={() => {
          setClicks((count) => count + 1)
        }}
      >
        Click target
      </button>
      <p id="clicks">{clicks}</p>
    </main>
  )
}
