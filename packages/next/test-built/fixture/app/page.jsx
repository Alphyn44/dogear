import Counter from './counter.jsx'
import Skipped from './skipped.jsx'

// A server component: no 'use client', so it renders on the server only. J2 (#78) checks
// that its elements are stamped with their lines in this file as written.
export default function Page() {
  return (
    <main>
      <h1>dogear next fixture</h1>
      <Counter />
      <Skipped />
    </main>
  )
}
