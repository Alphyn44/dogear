import { describe, expect, it } from 'vitest'

// The one place in this package allowed to reach into another package's source. Test
// files are excluded from tsconfig.build.json and are not a tsup entry, so the `rootDir`
// that forbids this in src/index.ts does not apply here — and going through the package
// name instead would resolve to core's dist/ and reintroduce a build dependency on
// `npm run typecheck`. See ./sentinel.ts for the full reasoning.
import { SENTINEL as CORE_SENTINEL } from '../../core/src/sentinel.js'
import { SENTINEL } from './sentinel.js'

describe('the sentinel copy in dogear-vite', () => {
  it('has not drifted from dogear-core, which is what check:leak scans for', () => {
    expect(SENTINEL).toBe(CORE_SENTINEL)
  })
})
