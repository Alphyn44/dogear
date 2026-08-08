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

  it('runs the M0 payload', () => {
    expect(served).toContain('[dogear] dev script loaded')
  })

  it('leaves the source file on disk untouched — nothing is written back', () => {
    // AC2: "no entry appears in the user's source". The injection is a response-time
    // transform, so index.html on disk must still be byte-for-byte what the fixture wrote
    // even after the server has served a page carrying the script.
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(RAW_HTML)
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
