/**
 * Where the element was *placed* — the `TabBar.tsx:42` half of the brief's running example.
 *
 * The pair matters more than either file does. Alt-clicking a tab yields a chain: the
 * `<button>` from Button.tsx, and this file's `<nav>` above it. "Shade this darker" means
 * the first; "move this two tabs over" means the second. C2 (#16) is what carries both.
 *
 * It is also what makes C5's (#19) component names visible in the dogfood app — before the
 * split, every element in this project reported `App`.
 */

import { Button } from './Button.js'

interface TabBarProps {
  readonly items: readonly string[]
  readonly onSelect: (item: string) => void
  readonly onClear: () => void
}

export function TabBar({ items, onSelect, onClear }: TabBarProps) {
  return (
    <nav className="tab-bar">
      {items.map((item) => (
        <Button
          key={item}
          label={item}
          onClick={() => {
            onSelect(item)
          }}
        />
      ))}
      <Button label="Clear" onClick={onClear} />
    </nav>
  )
}
