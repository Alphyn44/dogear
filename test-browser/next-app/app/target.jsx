'use client'

/**
 * J6 (#82): the element the browser points at in a Next app. The twin of H3's
 * ../../app/src/Target.jsx, under the same rules.
 *
 * **Exactly one button opening tag starts a line in this file, and the suite depends on it.**
 * `sourceLineOf` in ../../fixture.ts derives the expected `data-dogear-src` line by finding
 * that tag rather than by hard-coding a number, so editing this component moves the
 * expectation with it. Add elements below the counter, and keep them non-button.
 *
 * **The suite selects it by `id`, unlike H3's.** `next dev` puts a button of its own on the
 * page (the Next.js Dev Tools indicator), so a bare `button` selector matches two elements.
 *
 * **`data-hydrated` is the one thing this has that H3's twin does not.** Under Next the button
 * is server-rendered and gets its click handler only when React hydrates it. A modifier-click
 * that landed before then would leave the counter at 0 whatever dogear did, so the suite waits
 * for this attribute before any gesture. Set from an effect, which runs only after hydration;
 * the server render carries no attribute, so the two renders still agree.
 *
 * Inline styles rather than a stylesheet: the box has to be comfortably large (a real pointer
 * event needs a real target) and nowhere near the bottom-right corner, where dogear's badge
 * lives at `right: 12px; bottom: 12px`.
 */

import { useEffect, useState } from 'react'

export default function Target() {
  const [clicks, setClicks] = useState(0)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
  }, [])

  return (
    <main style={{ font: '16px system-ui, sans-serif', margin: 0, padding: '40px' }}>
      <h1>dogear next fixture</h1>
      <button
        id="target"
        type="button"
        style={{ padding: '32px 56px', fontSize: '20px', cursor: 'pointer' }}
        onClick={() => {
          setClicks((count) => count + 1)
        }}
      >
        Click target
      </button>
      <p id="clicks" data-hydrated={hydrated ? 'true' : undefined}>
        {clicks}
      </p>
    </main>
  )
}
