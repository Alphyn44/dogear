// A server component, as every App Router page is unless it says otherwise. The element the
// browser points at lives in ./target.jsx, a client component, because the suite also needs a
// click handler to show that dogear's gesture never reaches the app.
import Target from './target.jsx'

export default function Page() {
  return <Target />
}
