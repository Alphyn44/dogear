import { describe, expect, it } from 'vitest'

// The one place in this package allowed to reach into another package's source. Test files
// are outside every build, so no `rootDir` forbids it, and going through the package name
// instead would resolve to core's dist/ and put a build on `npm run typecheck`'s path. See
// ./sentinel.ts for the full reasoning.
import { SENTINEL as CORE_SENTINEL } from '../../core/src/sentinel.js'
import { SENTINEL } from './sentinel.js'

describe('the sentinel copy in dogear-host', () => {
  it('has not drifted from dogear-core, which is what check:leak scans for', () => {
    expect(SENTINEL).toBe(CORE_SENTINEL)
  })
})
