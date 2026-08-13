/**
 * Deliberately plain. This app exists to be *built* and *pointed at*, not to
 * demonstrate React — a handful of distinct, nested elements is exactly what M1's
 * overlay and M2's ancestor chain will need something to grab hold of.
 *
 * The click log is the one piece that is not decoration. B1's (#8) criterion is "the app's
 * own click handler does not fire", and until it existed this app had no click handlers at
 * all — so the criterion was unverifiable in the very app dogear is dogfooded in. Now a
 * plain click on a tab appends a line and a modifier-click must not.
 *
 * The tab bar lives in TabBar.tsx and Button.tsx rather than here, and that split is also
 * not decoration: it is the brief's `Button.tsx:12` vs `TabBar.tsx:42` example made real,
 * so C5's (#19) component names have more than one name to show and C2 (#16) has a chain
 * that genuinely crosses a component boundary.
 */

import { useState } from 'react'

import { TabBar } from './TabBar.js'

const items = ['Overview', 'Settings', 'Billing']

export function App() {
  const [log, setLog] = useState<string[]>([])

  return (
    <main className="app">
      <header className="masthead">
        <h1>dogear example</h1>
      </header>

      <p>
        The plugin injects a dev-only script — A1. View source and there is a{' '}
        <code>&lt;script data-dogear&gt;</code> in the head that no file in this app
        imports. Run <code>npm run build</code> and it is gone.
      </p>

      <p>
        Hold <kbd>Alt</kbd> to outline what is under the cursor, and Alt-click to leave a
        comment on it — B1 and B2. The log below is the control: a plain click adds a
        line, an Alt-click must not.
      </p>

      <TabBar
        items={items}
        onSelect={(item) => {
          setLog((entries) => [`clicked ${item}`, ...entries])
        }}
        onClear={() => {
          setLog([])
        }}
      />

      <section className="log">
        {/* The one test id in this app, so C3's (#17) `element.testId` and its selector
            fast path are observable by clicking rather than only in a unit test. */}
        <h2 data-testid="log-heading">Click log</h2>
        {log.length === 0 ? (
          <p className="empty">Nothing yet.</p>
        ) : (
          <ol>
            {log.map((entry, index) => (
              <li key={`${entry}-${String(index)}`}>{entry}</li>
            ))}
          </ol>
        )}
      </section>

      <section className="filler">
        <p>
          Everything below exists so the page scrolls. Hold <kbd>Alt</kbd> and scroll: the
          outline should re-target to whatever is under the stationary cursor, and the
          sticky header above should stay outlined correctly as it moves.
        </p>
        {Array.from({ length: 12 }, (_, index) => (
          <p key={index}>
            Paragraph {index + 1}. Alt-click any of these and the comment box should
            anchor below it — or flip above it, near the bottom of the viewport.
          </p>
        ))}
      </section>
    </main>
  )
}
