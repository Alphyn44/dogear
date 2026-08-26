import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'

import type { DevServer } from '../test-packed/fixture.js'
import {
  REPO_ROOT,
  createFixtureProject,
  discardFixture,
  launchBrowser,
  modifierClick,
  openPage,
  openPanel,
  overlayMounted,
  readFixtureQueue,
  requireBuild,
  sourceLineOf,
  startFixtureServer,
  submitBatch,
  typeAndQueue,
  waitForQueue,
} from './fixture.js'

/**
 * H3 (#55) — the claim on the front of the README, verified by something other than a person.
 *
 * Click an element in a running app and the comment arrives bound to the exact source file
 * and line. Both halves of that are thoroughly tested — the transform against fixtures, the
 * endpoint against a real server, the queue against a tolerance suite — and the seam where a
 * real browser event meets a real dev server has never been tested at all.
 *
 * **The `via` assertion is the story, and the second describe block is what makes it mean
 * something.** A test asserting only that *an annotation arrived* would pass on a build where
 * the attribute transform had stopped running entirely, because C3's selector-and-text floor
 * still produces an item. So the same gesture is driven a second time against a server
 * configured `transform: false`, and required to produce an annotation with **no**
 * `via: 'attribute'` site. That is this repository's standing rule about guards that would go
 * green forever — the `check-leak.test.ts` lesson, and the reason H8's `versions` job
 * self-tests its classifier before it judges anything.
 *
 * **Nothing here queries dogear's DOM, because nothing can.** The shadow root is `closed`
 * (packages/core/src/overlay.ts), `window.__dogear` carries only `sentinel`/`stop`/`start`/
 * `running`, and no test-only handle was added — B7's (#14) guarantee is a feature, not an
 * obstacle to work around. Every step is real input, and progress is confirmed through the one
 * surface a closed root leaves visible: a hit test that retargets to the host. That constraint
 * pushed the suite towards exactly the gestures the issue asked for.
 *
 * One server and one page per block, cases in order, telling one story — the same arrangement
 * and the same reason as ../test-packed/install.test.ts, where the setup dominates the run.
 *
 * Runs under vitest.browser.config.ts. Needs `npm run build` first and a Chromium binary; both
 * failures name their own fix. Deliberately not part of `npm run verify` — see that config.
 */

/** What the browser points at, and where the assertion expects to be told it lives. */
const TARGET = 'button'
const TARGET_FILE = 'src/Target.jsx'
/**
 * The opening tag whose position the transform stamps. Exactly one line in that file starts
 * with it — `sourceLineOf` anchors rather than searching, and says so if that stops holding.
 */
const TARGET_TAG = '<button'

const COMMENT = 'this button needs a louder hover state'

let browser: Browser

beforeAll(async () => {
  requireBuild()
  browser = await launchBrowser()
})

afterAll(async () => {
  await browser?.close()
})

describe('the round trip, with the transform on', () => {
  let root: string
  let server: DevServer
  let page: Page

  beforeAll(async () => {
    root = createFixtureProject()
    server = await startFixtureServer(root)
    page = await openPage(browser, server.origin)
  })

  afterAll(async () => {
    await page?.context().close()
    // Awaited: the tree being removed is one vite has modules open in.
    await server?.stop()
    if (root !== undefined) discardFixture(root)
  })

  it('renders nothing into the page until it is used', async () => {
    // B7's (#14) narrowed guarantee, observed in a real browser for the first time. It has
    // to be the first case in the block: everything below queues something, and the badge
    // outlives the gesture that created it.
    expect(await overlayMounted(page)).toBe(false)
    expect(await page.textContent('#clicks')).toBe('0')
  })

  it("delivers the annotation bound to the fixture's own file and line", async () => {
    await modifierClick(page, TARGET)

    // B1's other half, and the first time it has been asserted anywhere: the gesture is
    // dogear's, so the app's own handler must not have run. Its counterweight is the last
    // case in this block — on its own this would pass against a button that was simply
    // broken.
    expect(await page.textContent('#clicks')).toBe('0')
    expect(await overlayMounted(page)).toBe(true)

    await typeAndQueue(page, COMMENT)
    await openPanel(page)
    await submitBatch(page)

    const queue = await waitForQueue(root, 1)

    expect(queue.items).toHaveLength(1)
    const item = queue.items[0]!
    expect(item.comment).toBe(COMMENT)

    // The assertion the whole story is for. `sites[0]` is the innermost stamped ancestor,
    // which is the element that was clicked.
    const site = item.sites[0]
    expect(
      site,
      'the annotation carries no source site at all — the attribute transform did not run, ' +
        'or the plugin did not reach the file. Everything else about the overlay would ' +
        'still work.',
    ).toBeDefined()

    expect(site?.via).toBe('attribute')
    expect(site?.tag).toBe('button')
    // Repo-relative to the fixture's own git root, which is what makes the scratch project
    // necessary — see the docblock in ./fixture.ts.
    expect(site?.file).toBe(TARGET_FILE)
    expect(site?.line).toBe(sourceLineOf(root, TARGET_FILE, TARGET_TAG))
    expect(site?.column).toBeGreaterThan(0)
    // C5's (#19) display name, which travels with the same stamp.
    expect(site?.component).toBe('Target')
  })

  it("still lets a plain click reach the app's own handler", async () => {
    // The counterweight to the unfired-counter assertion above. Without this, a fixture whose
    // button had lost its handler would satisfy that one and prove nothing.
    await page.click(TARGET)

    expect(await page.textContent('#clicks')).toBe('1')
  })
})

describe('the same gesture with the transform off', () => {
  let root: string
  let server: DevServer
  let page: Page

  beforeAll(async () => {
    root = createFixtureProject({ transform: false })
    server = await startFixtureServer(root)
    page = await openPage(browser, server.origin)
  })

  afterAll(async () => {
    await page?.context().close()
    await server?.stop()
    if (root !== undefined) discardFixture(root)
  })

  it('still delivers an annotation, and it carries no attribute site', async () => {
    await modifierClick(page, TARGET)
    await typeAndQueue(page, COMMENT)
    await openPanel(page)
    await submitBatch(page)

    const queue = await waitForQueue(root, 1)
    const item = queue.items[0]!

    // The overlay is demonstrably still working: an item arrived, it carries what was typed,
    // and C3's floor resolved a selector for it. This is the half that makes the assertion
    // below a *discrimination* rather than a second way of saying "the page was broken".
    expect(item.comment).toBe(COMMENT)
    expect(item.element.selector).not.toBe('')
    expect(item.element.tag).toBe('button')

    expect(
      item.sites.filter((site) => site.via === 'attribute'),
      'an annotation carried an attribute-resolved site from a server running ' +
        '`dogear({ transform: false })`. Either the option stopped being honoured, or the ' +
        "positive case's `via` assertion is not testing what it claims to.",
    ).toEqual([])
  })
})

describe('the suite itself', () => {
  it('runs against a project outside this workspace', () => {
    // `findGitRoot` walks up for `.git`. A fixture inside the repository would resolve to the
    // repository, so the dev server would write into the developer's real .dogear/queue.json
    // and stamp paths naming this repo's own source. Every case above would pass while
    // testing something nobody asked for. Cheap to assert, and invisible if it stops holding.
    const root = createFixtureProject()

    try {
      expect(root.startsWith(REPO_ROOT)).toBe(false)
      // Nothing has run, so nothing has been written. The negative here is the point: the
      // fixture is inert until a browser drives it.
      expect(readFixtureQueue(root)).toBeUndefined()
    } finally {
      discardFixture(root)
    }
  })
})
