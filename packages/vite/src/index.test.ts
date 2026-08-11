import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HtmlTagDescriptor, Plugin, ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readConfig } from '../../core/src/client-config.js'
import { dogear } from './index.js'
import { SENTINEL } from './sentinel.js'

/**
 * B1 (#8) turned `transformIndexHtml` into a *conditional* hook: it injects only after
 * `configureServer` has found a git root, because dogear without a queue destination can
 * point at elements and never submit them. That means these tests must drive
 * `configureServer` first — a plugin whose hooks have not run injects nothing, which is
 * itself asserted below.
 *
 * The fake server is acceptable here and nowhere else: this file has always asserted the
 * *descriptor* dogear returns, and ./inject.test.ts is the real-dev-server counterweight
 * that proves what a browser is actually served.
 */

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-plugin-'))
  // A plain FILE, not a directory. `findGitRoot` checks with `existsSync` rather than
  // `isDirectory` precisely because worktrees and submodules use a `.git` file, so the
  // fixture exercises the shape that would otherwise never be covered.
  writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/fixture')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The smallest thing `configureServer` reads. Cast, because Vite's type is enormous. */
function fakeServer(serverRoot: string): ViteDevServer {
  return {
    config: { root: serverRoot, logger: { warn: () => {} } },
    middlewares: { use: () => {} },
  } as unknown as ViteDevServer
}

function configured(
  options: Parameters<typeof dogear>[0] = {},
  serverRoot = root,
): Plugin {
  const plugin = dogear(options)
  const hook = plugin.configureServer
  if (typeof hook !== 'function') {
    throw new Error('expected configureServer in function form')
  }

  // Vite calls it with the plugin context as `this`; dogear reads none of it.
  ;(hook as (server: ViteDevServer) => void).call(plugin as never, fakeServer(serverRoot))

  return plugin
}

function injectedTags(plugin: Plugin): HtmlTagDescriptor[] {
  const hook = plugin.transformIndexHtml
  if (typeof hook !== 'object') {
    throw new Error('expected transformIndexHtml in object form, so `order` is explicit')
  }

  // Vite declares the handler with a plugin-context `this` and `(html, ctx)` parameters.
  // dogear's implementation reads none of them — it injects the same tag on every HTML
  // entry — so this narrows the declared type to the signature actually written. The
  // assertions below are what hold that claim honest; a handler that started reading its
  // arguments would return something these tests reject.
  const handler = hook.handler as unknown as () => HtmlTagDescriptor[]

  return handler()
}

/** The injected tag's `src`, which is where the config now rides. */
function injectedSrc(plugin: Plugin): string {
  const src = injectedTags(plugin)[0]?.attrs?.['src']
  if (typeof src !== 'string') throw new Error('expected a script src')
  return src
}

describe('dogear()', () => {
  it.each([
    {
      field: 'name',
      expected: 'dogear',
      why: 'Vite identifies plugins by name in errors and ordering',
    },
    {
      field: 'apply',
      expected: 'serve',
      why: 'the primary production defense — the plugin must not exist during build',
    },
    {
      field: 'enforce',
      expected: 'pre',
      why: 'C1 needs to see real JSX, not the React plugin output',
    },
  ] as const)('sets $field to "$expected" — $why', ({ field, expected }) => {
    expect(dogear()[field]).toBe(expected)
  })

  it('returns a fresh object per call, so two Vite roots cannot share mutable state', () => {
    // Now load-bearing rather than hygienic: the git root and client config live in a
    // closure over this object, so a shared instance would let one Vite root's decision
    // about whether to inject leak into another's.
    expect(dogear()).not.toBe(dogear())
  })

  it('rejects an unknown modifier by name, at config time', () => {
    // Thrown here rather than defaulted, unlike core's resolveOptions — the audience is a
    // developer watching a dev server start, and a silently ignored typo would leave them
    // pressing a key that does nothing.
    expect(() => configured({ modifier: 'hyper' as never })).toThrow(
      /alt, ctrl, meta, shift/,
    )
  })
})

describe('transformIndexHtml (A1)', () => {
  it('runs in the post bucket, so the inline script is emitted verbatim', () => {
    const hook = dogear().transformIndexHtml
    // `pre` would hand the tag to Vite's core HTML handling, which extracts inline module
    // scripts into html-proxy modules. Nothing here needs that.
    expect(typeof hook === 'object' ? hook.order : undefined).toBe('post')
  })

  it('injects exactly one tag — a second dogear script would double every handler in B1', () => {
    expect(injectedTags(configured())).toHaveLength(1)
  })

  it.each([
    {
      property: 'tag',
      read: (tag: HtmlTagDescriptor) => tag.tag,
      expected: 'script',
      why: 'the whole feature is a script the user never imported',
    },
    {
      property: 'injectTo',
      read: (tag: HtmlTagDescriptor) => tag.injectTo,
      expected: 'head-prepend',
      why: 'dogear runs before the app module, so its listeners attach first',
    },
    {
      property: 'attrs.type',
      read: (tag: HtmlTagDescriptor) => tag.attrs?.['type'],
      expected: 'module',
      why: 'the body is an ES module importing @dogear/core from the dev server',
    },
    {
      property: 'attrs.data-dogear',
      read: (tag: HtmlTagDescriptor) => tag.attrs?.['data-dogear'],
      expected: SENTINEL,
      why: 'the attribute is what carries the sentinel into served HTML',
    },
  ])('sets $property to "$expected" — $why', ({ read, expected }) => {
    const tag = injectedTags(configured())[0]
    expect(tag).toBeDefined()
    expect(read(tag as HtmlTagDescriptor)).toBe(expected)
  })

  it('emits no inline body at all — the criterion F4 (#34) rests on', () => {
    // A strict `script-src 'self'` blocks inline execution outright, and dogear failed
    // silently with a console error that read like the host app's own bug. Anything back in
    // `children` reintroduces exactly that, on every project with a CSP.
    expect(injectedTags(configured())[0]?.children).toBeUndefined()
  })

  it('loads the client from the served endpoint', () => {
    expect(injectedSrc(configured())).toContain('/__dogear/client.js?')
  })

  it('passes a configured modifier through on the query string', () => {
    // Decoded with core's real reader rather than a string match, so this fails if either
    // half of the contract drifts.
    expect(
      readConfig(`http://localhost${injectedSrc(configured({ modifier: 'ctrl' }))}`),
    ).toEqual({ modifier: 'ctrl' })
  })

  it('follows a custom endpoint into the src', () => {
    expect(injectedSrc(configured({ endpoint: '/__x' }))).toContain('/__x/client.js?')
  })

  it('injects nothing before configureServer has run', () => {
    // Not a hypothetical ordering worry — it is the state every plugin object starts in, and
    // the reason `injection` is `undefined` rather than eagerly built in the factory.
    expect(injectedTags(dogear())).toHaveLength(0)
  })

  it('injects nothing when there is no git root', () => {
    // Decision: half-present is worse than absent. An overlay that can point at elements but
    // can never submit them is not a working tool, and the failure would surface as a MIME
    // error from a client.js that Vite's SPA fallback answered with index.html.
    const outside = mkdtempSync(join(tmpdir(), 'dogear-nogit-'))

    try {
      expect(injectedTags(configured({}, outside))).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('the same plugin under `vite build`', () => {
  it('is filtered out entirely by apply: "serve" — layer 1, the primary defense', async () => {
    // Kept here rather than in inject.test.ts because it needs no server. The strongest
    // available proof short of a real build: Vite resolves the plugin array for the build
    // command and dogear is simply not in it.
    const { resolveConfig } = await import('vite')
    const config = await resolveConfig({ root, plugins: [dogear()] }, 'build')

    expect(config.plugins.map((plugin) => plugin.name)).not.toContain('dogear')
  }, 30_000)
})
