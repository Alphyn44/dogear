/**
 * Deliberately plain. This app exists to be *built* and *pointed at*, not to
 * demonstrate React — a handful of distinct, nested elements is exactly what M1's
 * overlay and M2's ancestor chain will need something to grab hold of.
 */

const items = ['Overview', 'Settings', 'Billing']

export function App() {
  return (
    <main className="app">
      <h1>dogear example</h1>
      <p>
        The plugin is loaded but inert — script injection lands in A1. If you view source
        now, there should be no dogear script here at all.
      </p>
      <nav className="tab-bar">
        {items.map((item) => (
          <button key={item} className="tab" type="button">
            {item}
          </button>
        ))}
      </nav>
    </main>
  )
}
