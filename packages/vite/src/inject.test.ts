import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ViteDevServer } from 'vite'
import { createServer, resolveConfig } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dogear } from './index.js'
import { SENTINEL } from './sentinel.js'

/**
 * A1 end to end, minus the browser.
 *
 * The unit tests in ./index.test.ts assert the descriptor the hook returns, which proves
 * what dogear asked for. This one boots a real Vite dev server and asks it what the page
 * actually looks like — the difference matters, because `transformIndexHtml` results pass
 * through Vite's own tag serialization and hook ordering before a browser sees them.
 *
 * The fixture is a temp directory rather than examples/react-app: the example resolves
 * @dogear/vite through its exports map to dist/, so pointing this at it would make
 * `npm test` depend on a prior build. Same reasoning as scripts/check-leak.test.ts.
 */

const RAW_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head><title>fixture</title></head>',
  '  <body><div id="root"></div></body>',
  '</html>',
].join('\n')

let root: string
let server: ViteDevServer
let served: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dogear-inject-'))
  writeFileSync(join(root, 'index.html'), RAW_HTML)
  // B1 (#8) gated injection on finding a git root, so the fixture now needs one. A plain
  // FILE rather than a directory, deliberately: `findGitRoot` checks with `existsSync` and
  // not `isDirectory` because worktrees and submodules use a `.git` file, and this is the
  // only place that shape is exercised.
  writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/fixture')

  server = await createServer({
    root,
    logLevel: 'silent',
    // No HTTP listener needed — transformIndexHtml is what serves the page, and binding a
    // port would make this test flaky on a busy machine for no gain.
    server: { middlewareMode: true },
    plugins: [dogear()],
  })

  served = await server.transformIndexHtml('/index.html', RAW_HTML)
}, 30_000)

afterAll(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the fixture before dogear touches it', () => {
  // The negative control. Without this, every assertion below could be satisfied by a
  // fixture that already contained what we are looking for.
  it.each([SENTINEL, 'data-dogear', '[dogear]'])('does not contain %s', (needle) => {
    expect(RAW_HTML).not.toContain(needle)
  })
})

describe('the HTML a dev server actually serves', () => {
  it('carries the sentinel, which is what makes check:leak more than vacuous', () => {
    expect(served).toContain(SENTINEL)
  })

  it('carries a script tag the fixture never asked for', () => {
    expect(served).toMatch(/<script[^>]*data-dogear=/)
  })

  it('loads @dogear/core from the dev server', () => {
    // The M0 payload was an inline console.info. B1 (#8) replaced it with an inline module
    // importing the served bundle; F4 (#34) removed the inline body entirely, because a
    // strict `script-src 'self'` blocks inline execution.
    expect(served).toMatch(/<script[^>]*src="\/__dogear\/client\.js\?/)
  })

  it("emits the tag verbatim rather than through Vite's html-proxy machinery", () => {
    // What `order: 'post'` buys. A `pre` hook would route the tag through Vite's core HTML
    // handling, which rewrites script sources into its own module graph.
    expect(served).not.toContain('html-proxy')
  })

  it('leaves the source file on disk untouched — nothing is written back', () => {
    // AC2: "no entry appears in the user's source". The injection is a response-time
    // transform, so index.html on disk must still be byte-for-byte what the fixture wrote
    // even after the server has served a page carrying the script.
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(RAW_HTML)
  })
})

describe("what a strict `script-src 'self'` requires (F4, #34)", () => {
  /**
   * The regression guard for the defect that produced #34: dogear bootstrapped from an
   * **inline** `<script>`, which a strict Content-Security-Policy blocks outright. dogear then
   * did nothing at all, and the only symptom was a console error most people would read as
   * their own app's fault. `examples/react-app` sets no CSP, so nothing else here can catch a
   * regression.
   *
   * **Scope, stated plainly:** observing an actual CSP *violation* needs a browser enforcing
   * a policy, which this suite has no way to do — it asserts the two structural properties
   * `script-src 'self'` grants a script, against the HTML a real dev server serves. That is
   * the thing that would regress if somebody reintroduced an inline body; whether a browser
   * agrees remains a manual check, and is why #34 was found by hand rather than by CI.
   */

  it('injects no executable content inline — the property CSP actually blocks', () => {
    // Against the served HTML rather than the tag descriptor, because Vite's own tag
    // serialization is what decides whether a body reaches the document at all.
    expect(served).toMatch(/<script[^>]*data-dogear[^>]*>\s*<\/script>/)
  })

  it("loads from a same-origin path, which is what `'self'` grants", () => {
    // A root-relative src is same-origin by construction. An absolute URL to a CDN would
    // satisfy the assertion above and still be refused by the policy.
    const src = /<script[^>]*data-dogear[^>]*\ssrc="([^"]+)"/.exec(served)?.[1]

    expect(src).toBeDefined()
    expect(src?.startsWith('/')).toBe(true)
    expect(src).not.toMatch(/^https?:/)
  })

  it('still carries the sentinel, which the inline body used to be one carrier of', () => {
    // Removing the inline script removed one of A1's two sentinel carriers. The attribute is
    // the survivor here; the other is core's dist/client.js, which imports the constant.
    expect(served).toContain(SENTINEL)
  })
})

describe('a project that is not in a git repository', () => {
  // The negative half of B1's decision that half-present is worse than absent. Asserted
  // against a real dev server rather than the fake in ./index.test.ts, because the failure
  // it prevents is a browser-visible one: an injected `client.js` import that Vite's SPA
  // fallback answers with index.html, producing a MIME-type module error that reads like a
  // dogear bug rather than "you are not in a git repository".
  let outside: string
  let outsideServer: ViteDevServer
  let outsideServed: string

  beforeAll(async () => {
    outside = mkdtempSync(join(tmpdir(), 'dogear-nogit-'))
    writeFileSync(join(outside, 'index.html'), RAW_HTML)

    outsideServer = await createServer({
      root: outside,
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: [dogear()],
    })

    outsideServed = await outsideServer.transformIndexHtml('/index.html', RAW_HTML)
  }, 30_000)

  afterAll(async () => {
    await outsideServer?.close()
    rmSync(outside, { recursive: true, force: true })
  })

  it.each([SENTINEL, 'data-dogear', '/__dogear/'])(
    'serves HTML containing no %s',
    (needle) => {
      expect(outsideServed).not.toContain(needle)
    },
  )

  it('serves the page otherwise untouched', () => {
    expect(outsideServed).toContain('<div id="root">')
  })
})

describe('the same plugin under `vite build`', () => {
  it('is filtered out entirely by apply: "serve" — layer 1, the primary defense', async () => {
    // The strongest available proof short of a real build: Vite resolves the plugin array
    // for the build command and dogear is simply not in it, so there is no hook left that
    // could emit anything into a bundle.
    const config = await resolveConfig({ root, plugins: [dogear()] }, 'build')

    expect(config.plugins.map((plugin) => plugin.name)).not.toContain('dogear')
  }, 30_000)
})
