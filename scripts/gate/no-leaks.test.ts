import { existsSync, readFileSync } from 'node:fs'

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

const GATED_FIXTURE = 'packages/core/test-built/fixtures/gated-import'
const GATED_SOURCE = `${GATED_FIXTURE}/main.js`
const GATED_DIST = `${GATED_FIXTURE}/dist`

/**
 * The literal inside the fixture's `import.meta.env.DEV` branch. Duplicated here rather
 * than imported, because the fixture is plain `.js` built by Vite and importing it would
 * execute `document.body.textContent` in a Node test. The duplication is guarded: the first
 * assertion below fails if this string is no longer in the fixture at all, so the check
 * cannot quietly decay into asserting the absence of something that was never present.
 */
const GATED_MARKER = 'dogear-layer2-marker-must-not-ship'

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

  it('carries no dogear sentinel, source or component attribute, or package specifier', () => {
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

describe('the gated dynamic import (F1, layer 2)', () => {
  // Layer 2 is the defense for a consumer who cannot use our Vite plugin and writes
  // `if (import.meta.env.DEV) { import('@dogear/core') }` by hand. The claim is that a
  // bundler eliminates it statically. Nothing else in this repo exercises that path — the
  // example app goes through the plugin, which is layer 1.

  it('still contains the marker in its source', () => {
    // Guards the duplicated constant above. Without this, renaming the marker in the
    // fixture would leave the absence assertion below passing forever, having quietly
    // stopped testing anything.
    expect(
      readFileSync(GATED_SOURCE, 'utf8'),
      `${GATED_SOURCE} no longer contains "${GATED_MARKER}". The gate is asserting the ` +
        'absence of a string that is not in the fixture, which proves nothing.',
    ).toContain(GATED_MARKER)
  })

  it('has actually been built', () => {
    expect(
      existsSync(GATED_DIST),
      `${GATED_DIST} is missing. Run \`npm run build:fixtures\` first.`,
    ).toBe(true)
  })

  it('contains files to scan', () => {
    expect(scanBuildOutput(GATED_DIST).filesScanned).toBeGreaterThan(0)
  })

  it('eliminated the gated block entirely', () => {
    // The assertion layer 2 actually rests on. Scanning for `@dogear/` would not settle it:
    // a production build resolves the specifier through the exports map to the noop, and
    // the noop carries neither the sentinel nor a package specifier — so a noop bundled
    // inline would be invisible to every other rule in this file. A literal from inside the
    // dead branch is not.
    const survivors = scanBuildOutput(GATED_DIST, [
      {
        name: 'gated-block',
        needle: GATED_MARKER,
        why: 'the import.meta.env.DEV branch survived into production output — layer 2 failed',
      },
    ])

    expect(formatFindings(survivors.findings)).toBe('')
  })

  it('carries no sentinel, source or component attribute, or package specifier either', () => {
    // The standard rules on top, so the fixture is held to the same bar as the example.
    expect(formatFindings(scanBuildOutput(GATED_DIST).findings)).toBe('')
  })
})
