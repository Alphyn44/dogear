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
        The plugin injects a dev-only script — A1. View source and there is a{' '}
        <code>&lt;script data-dogear&gt;</code> in the head that no file in this app
        imports. Run <code>npm run build</code> and it is gone.
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
