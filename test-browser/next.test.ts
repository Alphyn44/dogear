import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { discard, manifestOf } from '../test-packed/fixture.js'
import type { Running } from '../test-packed/fixture.js'
import {
  REPO_ROOT,
  launchBrowser,
  modifierClick,
  openPage,
  openPanel,
  overlayMounted,
  sourceLineOf,
  submitBatch,
  typeAndQueue,
  waitForQueue,
} from './fixture.js'
import type { Bundler } from './next-fixture.js'
import {
  createNextProject,
  requireNextBuild,
  startNextDev,
  useLeg,
} from './next-fixture.js'

/**
 * J6 (#82): H3's round trip, in a Next app, under both of Next's dev bundlers.
 *
 * Click an element in a running Next app and the comment arrives bound to the exact file and
 * line. J2 stamps, J3 serves the endpoint and J4 injects the overlay, and J3's suite proves
 * each of them by `fetch`; nothing had yet put a real browser on a Next page and clicked. Each
 * bundler registers dogear's loader through a different hook (`turbopack.rules`, `webpack()`),
 * so each gets the whole story.
 *
 * **The stamping-off block under each bundler is H3's lesson, not a bonus.** C3's selector
 * floor still produces an annotation when stamping stops, so a suite that asserted only that
 * something arrived would pass on a broken build. The identical gesture against
 * `withDogear(…, { transform: false })` must arrive with no `via: "attribute"` site.
 *
 * **The packages come from packed tarballs** (J6's fourth criterion), installed once into a
 * project under `tmpdir` that every leg shares. See ./next-fixture.ts for why, and for why
 * this suite installs when H3's Vite leg in ./roundtrip.test.ts does not.
 *
 * Runs under vitest.browser.config.ts. Needs `npm run build` first, a Chromium binary, and
 * the registry; each failure names its own fix.
 */

/**
 * What the browser points at, and where the assertion expects to be told it lives. By `id`,
 * because `next dev` adds a button of its own (the Dev Tools indicator) to every page.
 */
const TARGET = '#target'
const TARGET_FILE = 'app/target.jsx'
/** Exactly one line in that file starts with it; see the docblock there. */
const TARGET_TAG = '<button'
/** The client component's own name, which C5 records beside the stamp. */
const TARGET_COMPONENT = 'Target'

const COMMENT = 'this button needs a louder hover state'

const BUNDLERS: readonly Bundler[] = ['turbopack', 'webpack']

let browser: Browser
let root: string

beforeAll(async () => {
  requireNextBuild()
  browser = await launchBrowser()
  // One install for all four legs. It reaches the registry for next and react, and dominates
  // the run, so it gets the config's install-sized timeout rather than a dev server's.
  root = await createNextProject()
}, 600_000)

afterAll(async () => {
  await browser?.close()
  if (root !== undefined) discard(root)
})

/**
 * Open the app and wait until React has hydrated the target.
 *
 * The button is server-rendered and gets its handler only on hydration, so a gesture made
 * before then would leave the counter unmoved whatever dogear did. ./next-app/app/target.jsx
 * sets `data-hydrated` from an effect, which runs only once hydration has happened.
 */
async function openHydrated(origin: string): Promise<Page> {
  const page = await openPage(browser, origin)
  await page.waitForSelector('#clicks[data-hydrated="true"]', { timeout: 60_000 })
  return page
}

describe.each(BUNDLERS)('next dev under %s', (bundler) => {
  describe('with stamping on', () => {
    let next: Running
    let page: Page

    beforeAll(async () => {
      useLeg(root, { bundler, stamp: true })
      next = await startNextDev(root, bundler)
      page = await openHydrated(next.origin)
    })

    afterAll(async () => {
      await page?.context().close()
      // Awaited, and the whole tree: the project is shared with the legs after this one.
      await next?.stop()
    })

    it('renders nothing into the page until it is used', async () => {
      // B7's (#14) guarantee under Next: the tag has loaded the overlay, and the overlay has
      // put nothing in the document yet. First, because everything below queues something.
      expect(await overlayMounted(page)).toBe(false)
      expect(await page.textContent('#clicks')).toBe('0')
    })

    it("delivers the annotation bound to the app's own file and line", async () => {
      await modifierClick(page, TARGET)

      // The gesture is dogear's, so the app's hydrated handler must not have run. The last
      // case in this block is its counterweight.
      expect(await page.textContent('#clicks')).toBe('0')
      expect(await overlayMounted(page), next.log()).toBe(true)

      await typeAndQueue(page, COMMENT)
      await openPanel(page)
      await submitBatch(page)

      const queue = await waitForQueue(root, 1)

      expect(queue.items).toHaveLength(1)
      const item = queue.items[0]!
      expect(item.comment).toBe(COMMENT)

      // The assertion the story is for. `sites[0]` is the innermost stamped ancestor, which is
      // the element that was clicked.
      const site = item.sites[0]
      expect(
        site,
        `the annotation carries no source site at all: ${bundler} did not run dogear's ` +
          'loader on the file, or the loader did not stamp it. Everything else about the ' +
          `overlay would still work.\n${next.log()}`,
      ).toBeDefined()

      expect(site?.via).toBe('attribute')
      expect(site?.tag).toBe('button')
      // Relative to the project's own git root, which is the scratch copy, not this repository.
      expect(site?.file).toBe(TARGET_FILE)
      expect(site?.line).toBe(sourceLineOf(root, TARGET_FILE, TARGET_TAG))
      expect(site?.column).toBeGreaterThan(0)
      expect(site?.component).toBe(TARGET_COMPONENT)
    })

    it("still lets a plain click reach the app's own handler", async () => {
      // Without this, a button that never hydrated would satisfy the unmoved counter above.
      await page.click(TARGET)

      expect(await page.textContent('#clicks')).toBe('1')
    })
  })

  describe('with stamping off', () => {
    let next: Running
    let page: Page

    beforeAll(async () => {
      useLeg(root, { bundler, stamp: false })
      next = await startNextDev(root, bundler)
      page = await openHydrated(next.origin)
    })

    afterAll(async () => {
      await page?.context().close()
      await next?.stop()
    })

    it('still delivers an annotation, and it carries no attribute site', async () => {
      await modifierClick(page, TARGET)
      await typeAndQueue(page, COMMENT)
      await openPanel(page)
      await submitBatch(page)

      const queue = await waitForQueue(root, 1)
      const item = queue.items[0]!

      // The overlay demonstrably still works, which makes the assertion below a
      // discrimination rather than a second way of saying "the page was broken".
      expect(item.comment).toBe(COMMENT)
      expect(item.element.selector).not.toBe('')
      expect(item.element.tag).toBe('button')

      expect(
        item.sites.filter((site) => site.via === 'attribute'),
        'an annotation carried an attribute-resolved site from `next dev` running ' +
          `withDogear(…, { transform: false }) under ${bundler}. Either the option stopped ` +
          "reaching the loader, or the stamping block's `via` assertion is not testing what " +
          'it claims to.',
      ).toEqual([])
    })
  })
})

describe('the project under test', () => {
  it('lives outside this workspace', () => {
    // `findGitRoot` walks up for `.git`. A project inside the repository would resolve to it,
    // and every leg would write into the developer's own queue.
    expect(root.startsWith(realpathSync.native(REPO_ROOT))).toBe(false)
  })

  it.each(['core', 'next'] as const)(
    'has dogear-%s installed from its tarball, not linked to the workspace',
    (dir) => {
      // J6's fourth criterion, observed rather than assumed: a real directory holding the
      // version this repository's manifest names. A workspace link would be a symlink (or a
      // junction) whose real path is inside this repository.
      const installed = join(root, 'node_modules', `dogear-${dir}`)

      expect(lstatSync(installed).isSymbolicLink()).toBe(false)
      expect(
        realpathSync.native(installed).startsWith(realpathSync.native(REPO_ROOT)),
      ).toBe(false)

      const manifest = JSON.parse(
        readFileSync(join(installed, 'package.json'), 'utf8'),
      ) as { readonly version: string }
      expect(manifest.version).toBe(manifestOf(dir).version)
    },
  )
})
