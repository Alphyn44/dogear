import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Browser, Page } from 'playwright'

import { REPO_ROOT, discard, startDevServer } from '../test-packed/fixture.js'
import type { DevServer } from '../test-packed/fixture.js'

export { REPO_ROOT } from '../test-packed/fixture.js'

/**
 * The scaffolding for H3 (#55): a real dev server with the plugin loaded, a real browser
 * driving real input at it, and the resulting `.dogear/queue.json` read from disk.
 *
 * **Why a scratch project rather than `examples/react-app`.** The issue proposes the example
 * app, and it cannot be: the endpoint writes to `queuePathFor(findGitRoot(server.config.root))`,
 * the example's git root is *this repository*, and there is no override. Every run would append
 * test annotations to the developer's own queue and stamp paths naming this repo's real source
 * files. The fixture needs a git root of its own, which is the same conclusion — and the same
 * bare `.git` directory — that `createScratchProject` in ../test-packed/fixture.ts reached.
 *
 * **Why it installs nothing.** H1's suite packs and installs because its subject is what npm
 * publishes. This suite's subject is what the browser does, and putting a registry on its
 * critical path would buy nothing and cost minutes. `react`, `react-dom`,
 * `@vitejs/plugin-react` and `vite` are all hoisted to the workspace root, so one junction
 * reaches them — along with the workspace symlinks for `dogear-vite` and `dogear-core`, which
 * means this consumes the **built** plugin through its exports map exactly as the example app
 * does. That is deliberate: a source alias would skip the exports map and the build output,
 * which are precisely what F1 layer 3 and the leak gate exist to police.
 *
 * `startDevServer`, `discard` and `REPO_ROOT` are imported from H1's harness rather than
 * copied. The spawn there is already the right one — vite's own CLI, in the scratch root, on
 * a claimed port, bound to `127.0.0.1` for the reason its comment gives — and this repository
 * has already been bitten once by two copies of a thing drifting apart (see the note on
 * `parity.test.ts` in CLAUDE.md).
 */

/** This file lives in `test-browser/`. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The committed fixture app, copied into each scratch root. */
export const APP_SOURCE = join(HERE, 'app')

/**
 * The build outputs the fixture consumes, and the message when they are missing.
 *
 * Checked up front rather than left to surface later: without core's `dist/client.js` the
 * plugin serves `MISSING_BUNDLE_STUB`, the overlay never loads, and every case in the suite
 * fails as "no annotation arrived" — which names the wrong thing entirely.
 */
const REQUIRED_BUILDS = [
  join('packages', 'core', 'dist', 'client.js'),
  join('packages', 'vite', 'dist', 'index.js'),
] as const

export function requireBuild(): void {
  const missing = REQUIRED_BUILDS.filter((path) => !existsSync(join(REPO_ROOT, path)))
  if (missing.length === 0) return

  throw new Error(
    `the browser suite consumes the built packages and ${missing.join(', ')} ` +
      'is missing. Run `npm run build` first.',
  )
}

export interface FixtureOptions {
  /**
   * What to pass to `dogear({ transform })`.
   *
   * `false` is the negative leg: the overlay still works and an annotation still arrives, it
   * just carries no `via: 'attribute'` site. That is what proves the positive case's assertion
   * discriminates rather than passing by construction.
   */
  readonly transform?: boolean
}

/**
 * A Vite + React project under `tmpdir`, with its own git root and the workspace's modules.
 *
 * Under `tmpdir` and never inside this repository, for the reason above: `findGitRoot` walks
 * *up*, so a fixture inside the workspace resolves to the workspace.
 */
export function createFixtureProject({ transform = true }: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), `dogear-browser-${transform ? 'on' : 'off'}-`))

  // A bare `.git` directory rather than a real repository. `findGitRoot` only looks for the
  // entry, which is the arrangement ../test-packed/fixture.ts already documents.
  mkdirSync(join(root, '.git'))

  cpSync(APP_SOURCE, root, { recursive: true })

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dogear-browser-fixture',
        private: true,
        version: '0.0.0',
        type: 'module',
      },
      null,
      2,
    )}\n`,
  )

  writeFileSync(join(root, 'vite.config.js'), viteConfig(root, transform))

  linkModules(root)

  return root
}

/**
 * The generated config, and every line of it is load-bearing.
 *
 * **`server.fs.allow`.** The root is under `tmpdir` while its modules resolve back into this
 * repository — Vite does not preserve symlinks, so `react` and `dogear-vite` realpath to
 * paths outside the root. Vite derives its default allow-list from the root, so without this
 * every one of those requests is a 403 and the page loads nothing.
 *
 * **`cacheDir`.** The default is `<root>/node_modules/.vite`, which through the junction below
 * is *this repository's* `node_modules`. Pre-bundled fixture dependencies would be written
 * into the developer's real tree and outlive the test. Naming a directory inside the scratch
 * root keeps everything the run creates in the tree the run deletes.
 *
 * Paths are JSON-encoded with forward slashes: a Windows backslash inside a JavaScript string
 * literal is an escape character.
 */
function viteConfig(root: string, transform: boolean): string {
  const posix = (path: string): string => JSON.stringify(path.replace(/\\/g, '/'))

  return [
    "import react from '@vitejs/plugin-react'",
    "import { dogear } from 'dogear-vite'",
    '',
    'export default {',
    `  plugins: [dogear({ transform: ${String(transform)} }), react()],`,
    "  cacheDir: '.vite',",
    `  server: { fs: { allow: [${posix(root)}, ${posix(REPO_ROOT)}] } },`,
    '}',
    '',
  ].join('\n')
}

/**
 * The workspace's `node_modules`, reachable from the scratch root.
 *
 * `'junction'` is ignored off Windows and creates an ordinary symlink there; on Windows it is
 * what makes this work without elevation, which a directory symlink would require.
 */
function linkModules(root: string): void {
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction')
}

/**
 * Remove the link **before** the tree, and this ordering is not defensive style.
 *
 * A recursive delete that walked into the link would delete this repository's `node_modules`.
 * Node is documented not to follow links when removing, and that is almost certainly true of
 * junctions too — but "almost certainly" is not a basis for pointing `rmSync(recursive)` at a
 * live handle on the developer's own tree. Unlinking first makes the question not arise.
 *
 * Both spellings are tried because Windows removes a junction with `rmdir` and rejects
 * `unlink` on it with EPERM, while POSIX does the reverse for a symlink.
 */
export function discardFixture(root: string): void {
  const link = join(root, 'node_modules')

  try {
    if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
      try {
        unlinkSync(link)
      } catch {
        rmdirSync(link)
      }
    }
  } catch (error) {
    // Leave the tree alone entirely rather than risk the recursive delete reaching the link.
    // Under tmpdir the OS reclaims it; the repository's node_modules is not recoverable.
    console.warn(
      `[test-browser] could not unlink ${link}, so ${root} is being left in place: ` +
        String(error),
    )
    return
  }

  discard(root)
}

/** Start vite in a fixture project. Re-exported so the suite imports one harness, not two. */
export function startFixtureServer(root: string): Promise<DevServer> {
  return startDevServer(root)
}

/**
 * A browser, or an error naming the command that installs one.
 *
 * `playwright` the library ships no browser binaries — they are a separate download, which is
 * why this suite is a CI job of its own rather than a step in `npm run verify`. The failure
 * without this wrapper is a stack trace about a missing executable path; with it, it is the
 * command to run. Same shape as `binOf`'s missing-devDependency error in H1's harness.
 */
export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright')

  try {
    return await chromium.launch()
  } catch (error) {
    throw new Error(
      'could not launch Chromium. The playwright package ships no browser binaries — run ' +
        '`npx playwright install chromium` (add `--with-deps` on Linux).\n' +
        String(error),
    )
  }
}

/**
 * A page on a fresh context, sized so the fixture's target and dogear's badge cannot overlap.
 *
 * The viewport is stated rather than left to Playwright's default because
 * {@link badgePoint} is derived from it.
 */
export async function openPage(browser: Browser, origin: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  // A failing fixture is nearly always a page-side error, and a closed shadow root means
  // there is very little else to look at.
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[page] ${message.text()}`)
  })
  page.on('pageerror', (error) => {
    console.error('[page]', error)
  })

  await page.goto(origin, { waitUntil: 'load' })
  return page
}

/** The tag `createOverlay` mounts. Not a registered custom element — see overlay.ts. */
export const HOST_TAG = 'dogear-overlay'

/** Is the overlay host in the document at all? B7's (#14) zero-nodes guarantee, observable. */
export function overlayMounted(page: Page): Promise<boolean> {
  return page.evaluate(
    (tag) => document.querySelector(tag) !== null,
    HOST_TAG,
  ) as Promise<boolean>
}

/**
 * Does a hit test at (x, y) land inside the overlay?
 *
 * The only thing a closed shadow root leaves visible. A hit inside it retargets to the host,
 * so `elementFromPoint` naming the host means *something of dogear's* is there and taking
 * pointer events — which is as much as anything outside the root can know, and enough to tell
 * a mis-aimed click from a broken one.
 */
export function hitsOverlay(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ([tag, px, py]) =>
      (document.elementFromPoint(px as number, py as number)?.tagName.toLowerCase() ??
        null) === tag,
    [HOST_TAG, x, y] as const,
  ) as Promise<boolean>
}

/**
 * Where to click to hit the badge.
 *
 * Derived from `.badge { right: 12px; bottom: 12px }` in packages/core/src/styles.ts plus its
 * own box — 12px text at line-height 1.45, 5px of padding each side, 1px of border, so around
 * 29px tall and a little narrower. 14px in from each edge is inside that for any count the
 * suite produces, and comfortably clear of the pill's rounded corners.
 *
 * The badge is the panel's *only* handle: `registry.on(badge.element, 'click', togglePanel)`
 * is the whole of it, there is no chord, and the shadow root is closed — so there is no
 * locator to ask. {@link openPanel} checks the point before using it, which turns a restyle
 * into a failure that names this function instead of a submit that silently does nothing.
 */
const BADGE_INSET = 12
const BADGE_REACH = 14

function badgePoint(viewport: { width: number; height: number }): {
  x: number
  y: number
} {
  return {
    x: viewport.width - BADGE_INSET - BADGE_REACH,
    y: viewport.height - BADGE_INSET - BADGE_REACH,
  }
}

function viewportOf(page: Page): { width: number; height: number } {
  const size = page.viewportSize()
  if (size === null) throw new Error('the fixture page has no viewport size')
  return size
}

/**
 * The pointing gesture: hold the modifier, click, release.
 *
 * A real keyboard-modified pointer event, never `element.click()`. The distinction is the
 * gesture itself — `isHeld` reads `altKey` off the event, and a synthetic click carries none
 * of the modifier state that makes this dogear's click rather than the app's.
 */
export async function modifierClick(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  if (box === null) throw new Error(`${selector} has no box to click`)

  await page.keyboard.down('Alt')
  // Moved first, then clicked. `elementAt` hit-tests the last known pointer position, so a
  // click with no preceding move is the one case where the outline has never been computed.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.up('Alt')
}

/** Type into the comment box and queue it. The box already has focus — see `capture`. */
export async function typeAndQueue(page: Page, comment: string): Promise<void> {
  await page.keyboard.type(comment)
  await page.keyboard.press('Enter')
}

/**
 * Click the badge to open the review panel.
 *
 * Checks the hit first: a badge that has moved would otherwise surface three steps later as
 * a submit that wrote nothing, with no indication of which of the two went wrong.
 */
export async function openPanel(page: Page): Promise<void> {
  const { x, y } = badgePoint(viewportOf(page))

  if (!(await hitsOverlay(page, x, y))) {
    throw new Error(
      `nothing of dogear's is at (${String(x)}, ${String(y)}), where the badge should be. ` +
        'Either the queue is empty — the badge is hidden at count 0 — or `.badge` in ' +
        'packages/core/src/styles.ts has moved and badgePoint() in this file needs to follow.',
    )
  }

  await page.mouse.click(x, y)
}

/**
 * Submit the batch with the chord the panel's own footer advertises.
 *
 * `Ctrl+Enter` is guarded on `panel.open && event.target === overlay.host`, and `openPanel()`
 * satisfies the second half by calling `panel.focusFirst()` — focus inside a closed root
 * retargets to the host, which is how the guard is meant to read. So this must follow
 * {@link openPanel} and cannot replace it.
 */
export async function submitBatch(page: Page): Promise<void> {
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter',
  )
}

/** Everything the queue file holds, or `undefined` when nothing has been written. */
export interface FixtureQueue {
  readonly version: number
  readonly items: readonly {
    readonly comment: string
    readonly sites: readonly {
      readonly file: string
      readonly line: number
      readonly column: number
      readonly tag: string
      readonly component?: string
      readonly via: string
    }[]
    readonly element: { readonly selector: string; readonly tag: string }
  }[]
}

export function readFixtureQueue(root: string): FixtureQueue | undefined {
  const path = join(root, '.dogear', 'queue.json')
  if (!existsSync(path)) return undefined

  return JSON.parse(readFileSync(path, 'utf8')) as FixtureQueue
}

/**
 * Wait for the queue file to hold `count` items, or give up with what it actually holds.
 *
 * The submit is a POST the browser does not report finishing, so there is nothing on the page
 * to await. Polling the file is the honest wait: it is the artefact under test, and the
 * failure message is the file's real contents rather than a timeout.
 */
export async function waitForQueue(
  root: string,
  count: number,
  timeoutMs = 15_000,
): Promise<FixtureQueue> {
  const deadline = Date.now() + timeoutMs
  let last: FixtureQueue | undefined

  for (;;) {
    last = readFixtureQueue(root)
    if (last !== undefined && last.items.length >= count) return last

    if (Date.now() > deadline) {
      throw new Error(
        `.dogear/queue.json did not reach ${String(count)} item(s) within ` +
          `${String(timeoutMs)}ms. It holds: ${JSON.stringify(last ?? null)}`,
      )
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * The 1-based line an opening tag starts on, read out of the fixture's own copied source.
 *
 * Derived rather than written down: the stamp records where the opening element *is*, so a
 * hard-coded number would turn any edit to Target.jsx into a failure that named the wrong
 * thing — or, worse, would keep passing against a line that had moved. The same discipline as
 * scripts/packaging.test.ts and the two docs.test.ts suites, which read the repository's
 * committed files instead of restating them.
 *
 * **The match is anchored to the start of the trimmed line, not `includes`.** The first
 * version used `includes` and found three lines: JSX is not the only place a `<button` can
 * appear in a `.jsx` file, and Target.jsx's own docblock explains the rule in prose. Anchoring
 * is also the more honest test — a stamp records where an element *starts*, and an opening tag
 * that does not begin its line is not what this is looking for.
 *
 * Ambiguity is an error rather than a first match. Silently taking one of several would assert
 * a line number against an element nobody meant, which is the failure this whole function
 * exists to make impossible.
 *
 * Reads the *copy*, not `app/`, so what is asserted is what the dev server actually served.
 */
export function sourceLineOf(
  root: string,
  relativePath: string,
  opening: string,
): number {
  const lines = readFileSync(join(root, relativePath), 'utf8').split(/\r?\n/)

  const matches = lines.flatMap((line, index) =>
    line.trimStart().startsWith(opening) ? [index + 1] : [],
  )

  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one line starting with ${JSON.stringify(opening)} in ` +
        `${relativePath}, found ${String(matches.length)}. ` +
        'See the docblock in app/src/Target.jsx.',
    )
  }

  return matches[0]!
}
