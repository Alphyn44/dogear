import { describe, expect, it } from 'vitest'

// The one place in this package allowed to reach into another package's source, for the
// reason packages/cli/src/parity.test.ts states: test files are not a tsup entry and are
// excluded from declaration emit, so the boundary that keeps src/ from importing across
// packages does not apply here — and going through the package name would resolve to vite's
// dist/ and make `npm test` depend on a prior build.
import {
  COMPONENT_ATTRIBUTE as COMPONENT_ATTRIBUTE_IN_VITE,
  SOURCE_ATTRIBUTE as SOURCE_ATTRIBUTE_IN_VITE,
} from '../../vite/src/stamp.js'
import { COMPONENT_ATTRIBUTE, SOURCE_ATTRIBUTE } from './sites.js'

/**
 * The writer is `dogear-vite`'s JSX transform; the reader is this package's `collectSites`.
 * They cannot import each other — core is framework-agnostic and knows nothing about Vite,
 * which is the same constraint that makes ./submit.ts carry its own `PROTOCOL_VERSION`. So
 * the attribute names exist twice.
 *
 * A drift between the two copies fails **open and silent**, which is why this file exists:
 * core would query an attribute nobody stamps, every annotation would carry `sites: []`, and
 * every other test in the repo would still pass — ./sites.test.ts builds its own fixtures
 * from core's constant, so it would agree with itself all the way down.
 *
 * Mirrors packages/cli/src/parity.test.ts, which guards the queue location for the same
 * reason, and packages/vite/src/sentinel.test.ts, which guards the leak sentinel's copy.
 */

describe('the source attributes read by dogear-core', () => {
  it('agree with the ones dogear-vite stamps', () => {
    expect(SOURCE_ATTRIBUTE).toBe(SOURCE_ATTRIBUTE_IN_VITE)
    expect(COMPONENT_ATTRIBUTE).toBe(COMPONENT_ATTRIBUTE_IN_VITE)
  })
})
