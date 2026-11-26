'use client'

import { useEffect, useState } from 'react'

/**
 * F1 layer 2 under Next: the gated dynamic import, in the form a Next consumer writes it. J4
 * (#80) commits what J1's spike found: both bundlers eliminate the branch from a production
 * build. `scripts/gate/no-leaks.test.ts` asserts the marker below is ABSENT from `.next/`.
 *
 * Next's dev flag is `process.env.NODE_ENV === 'development'`, not Vite's `import.meta.env.DEV`;
 * see packages/core/test-built/fixtures/gated-import/main.js for the Vite form and for why the
 * marker sits inside the branch rather than beside it.
 *
 * Turbopack's production server maps carry this file verbatim in `sourcesContent`, which is
 * why the gate scans a map without that field. The marker is spelled without any dogear
 * package name, so a branch that survived trips this fixture's own rule and no other.
 */
export default function Gated() {
  const [title, setTitle] = useState('waiting')

  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      import('dogear-core').then((core) => {
        setTitle(`next-layer2-marker-must-not-ship:${core.IS_NOOP}`)
      })
    }
  }, [])

  return <p id="gated">{title}</p>
}
