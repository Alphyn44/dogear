/**
 * H3 (#55) — the fixture app's entry.
 *
 * Deliberately the smallest thing that is still a real React app: the transform only runs on
 * `.jsx`/`.tsx`, and the seam under test is a real browser event reaching a real dev server,
 * so anything beyond mounting a component is scenery.
 *
 * No `StrictMode`. It double-invokes render in development, which would double the click
 * counter ./Target.jsx uses to prove the app's own handler did *not* fire — a fixture whose
 * counting is subtle is a fixture that can lie.
 */

import { createRoot } from 'react-dom/client'

import { Target } from './Target.jsx'

const mount = document.getElementById('root')
if (mount === null) throw new Error('the fixture page is missing #root')

createRoot(mount).render(<Target />)
