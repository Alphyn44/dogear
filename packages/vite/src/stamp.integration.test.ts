import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import react from '@vitejs/plugin-react'
import type { ViteDevServer } from 'vite'
import { createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dogear } from './index.js'
import { SOURCE_ATTRIBUTE } from './stamp.js'

/**
 * C1's (#15) ordering claim, which nothing else can prove.
 *
 * `enforce: 'pre'` exists so dogear's transform sees real JSX rather than already-compiled
 * `jsx()` calls. Every other test in this package asserts what dogear *asked for* — the
 * plugin descriptor, or `stampSource` in isolation. Neither notices if Vite stops honouring
 * the ordering, or if `@vitejs/plugin-react` starts dropping unknown attributes. So this
 * one boots a real dev server with both plugins and reads what the module graph actually
 * produces, the same way ./inject.test.ts does for A1.
 *
 * It is also the only place the spread criterion is checked *after* compilation, which is
 * where it matters: the criterion is about the compiled object literal's key order, and the
 * source-level assertion in ./stamp.test.ts is only a proxy for it.
 *
 * A temp directory rather than examples/react-app, for the reason inject.test.ts gives —
 * the example resolves @dogear/vite through its exports map to dist/, so pointing at it
 * would make `npm test` depend on a prior build.
 */

const SOURCE = [
  'export function Panel({ rest }) {',
  '  return (',
  '    <section className="panel">',
  '      <button {...rest} type="button">Save</button>',
  '      <Nested />',
  '    </section>',
  '  )',
  '}',
  '',
  'function Nested() {',
  '  return <p>inner</p>',
  '}',
].join('\n')

const require = createRequire(import.meta.url)

let root: string
let server: ViteDevServer
let output: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dogear-stamp-'))
  // A plain FILE, matching the shape findGitRoot has to support for worktrees and
  // submodules — and the same fixture shape index.test.ts and inject.test.ts use.
  writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/fixture')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'Panel.jsx'), SOURCE)

  server = await createServer({
    root,
    logLevel: 'silent',
    server: { middlewareMode: true },
    // Nothing here needs prebundled dependencies — the aliases below hand React's runtime
    // over directly. Left on, the optimizer starts a scan that keeps `server.close()`
    // waiting past the hook timeout, which fails the suite after every assertion in it has
    // already passed.
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      // The fixture lives in the OS temp directory, so Node's upward walk for
      // `node_modules` never reaches this repo's copy of React — and `transformRequest`
      // resolves imports as well as running transforms, so the automatic JSX runtime import
      // the React plugin injects would fail before any assertion ran. Aliasing is the small
      // fix; installing React into a temp directory per test run is the large one.
      alias: {
        'react/jsx-dev-runtime': require.resolve('react/jsx-dev-runtime'),
        'react/jsx-runtime': require.resolve('react/jsx-runtime'),
      },
    },
    // Both plugins, in the order a real config lists them. dogear's `enforce: 'pre'` is
    // what puts it first regardless, which is precisely the thing under test.
    plugins: [dogear(), react()],
  })

  const result = await server.transformRequest('/src/Panel.jsx')
  if (result === null) throw new Error('expected the module to transform')
  output = result.code
}, 30_000)

afterAll(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the fixture before dogear touches it', () => {
  // The negative control. Without it every assertion below could be satisfied by a fixture
  // that already contained what we are looking for.
  it('contains no dogear attribute of its own', () => {
    expect(SOURCE).not.toContain(SOURCE_ATTRIBUTE)
  })
})

describe('a real dev server with dogear and @vitejs/plugin-react', () => {
  it('survives JSX compilation into the emitted module', () => {
    // The load-bearing assertion. If `enforce: 'pre'` stopped being honoured, dogear would
    // be handed `jsx("section", {...})` and would find no JSX to stamp at all — this would
    // read zero occurrences rather than a wrong value.
    expect(output).toContain(SOURCE_ATTRIBUTE)
  })

  it('compiled away the JSX, so the attribute really did pass through the React plugin', () => {
    // Guards the test itself: were the react plugin silently not running, the assertions
    // here would be checking dogear's own output rather than anything downstream of it.
    expect(output).not.toContain('<section')
    expect(output).toMatch(/jsx(DEV|s)?\(/)
  })

  it('stamps each host element with its own original line', () => {
    // Pre-compilation positions, per acceptance criterion 2. The React plugin has moved
    // every one of these elements by this point; the values still describe the file on disk.
    expect(output).toContain(`${SOURCE_ATTRIBUTE}": "src/Panel.jsx:3:5`)
    expect(output).toContain(`${SOURCE_ATTRIBUTE}": "src/Panel.jsx:4:7`)
    expect(output).toContain(`${SOURCE_ATTRIBUTE}": "src/Panel.jsx:11:10`)
  })

  it('leaves the component element unstamped', () => {
    // `<Nested />` is a component reference. Exactly three host elements exist in the
    // fixture, so a fourth occurrence would mean components had started being stamped.
    expect(output.split(SOURCE_ATTRIBUTE)).toHaveLength(4)
  })

  it('keeps the stamp after the spread in the compiled props object', () => {
    // Acceptance criterion 4, where it actually binds. JSX compiles to an object literal
    // whose later keys win, so `{...rest}` must appear before ours or a prop spread could
    // overwrite the source location with a parent's stale value.
    const spread = output.indexOf('...rest')
    const stamp = output.indexOf(`${SOURCE_ATTRIBUTE}": "src/Panel.jsx:4:7`)

    expect(spread).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(spread)
  })
})
