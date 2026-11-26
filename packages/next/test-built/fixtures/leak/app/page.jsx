import Gated from './gated.jsx'

// A server component with host elements, so a stamp that leaked would have somewhere to land.
export default function Page() {
  return (
    <main>
      <h1>next leak fixture</h1>
      <Gated />
    </main>
  )
}
