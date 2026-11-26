'use client'

import { useState } from 'react'

// A client component, which webpack compiles once per layer. J2 (#78) checks its element is
// stamped in the server-rendered HTML like any other.
export default function Counter() {
  const [count, setCount] = useState(0)

  return (
    <button id="counter" onClick={() => setCount(count + 1)}>
      clicked {count}
    </button>
  )
}
