import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { formatFindings, scanBuildOutput, scanManifest } from '../check-leak.js'

/**
 * The CI gate — F2's acceptance criterion, run as `npm run check:leak`.
 *
 * Deliberately NOT part of `npm test`: it reads build output, and making the ordinary
 * test suite depend on a fresh build would slow every turn down for no benefit. It lives
 * in scripts/gate/ so vitest.config.ts and vitest.leak.config.ts can select on directory
 * and need no exclude rules to stay out of each other's way.
 *
 * Every assertion is `formatFindings(...)` compared against the empty string, so when it
 * fails the whole report — file, rule, occurrence count, excerpt — arrives as the diff.
 */

const EXAMPLE_DIST = 'examples/react-app/dist'
const EXAMPLE_MANIFEST = 'examples/react-app/package.json'
const CORE_NOOP = 'packages/core/dist/noop.js'

describe('the consumer bundle', () => {
  it('has actually been built', () => {
    expect(
      existsSync(EXAMPLE_DIST),
      `${EXAMPLE_DIST} is missing. Run \`npm run build:example\` first — this gate ` +
        'cannot pass by having nothing to look at.',
    ).toBe(true)
  })

  it('contains files to scan', () => {
    // Guards the arrangement where dist/ exists but is empty. "Zero findings" from zero
    // files is not evidence of anything.
    expect(scanBuildOutput(EXAMPLE_DIST).filesScanned).toBeGreaterThan(0)
  })

  it('carries no dogear sentinel, source attribute, or package specifier', () => {
    expect(formatFindings(scanBuildOutput(EXAMPLE_DIST).findings)).toBe('')
  })
})

describe("core's noop build", () => {
  // The noop is what a production resolver actually gets (exports map, layer 3). If the
  // sentinel ever reaches it, every downstream consumer's build starts failing this check
  // for a bug that is ours — and nothing else in the repo would catch it.
  it('has been built', () => {
    expect(
      existsSync(CORE_NOOP),
      `${CORE_NOOP} is missing. Run \`npm run build\` first.`,
    ).toBe(true)
  })

  it('carries no sentinel — it is the file production resolves to', () => {
    expect(formatFindings(scanBuildOutput(CORE_NOOP).findings)).toBe('')
  })
})

describe('the consumer manifest', () => {
  it('keeps dogear out of runtime dependencies', () => {
    expect(formatFindings(scanManifest(EXAMPLE_MANIFEST))).toBe('')
  })
})
