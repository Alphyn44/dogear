import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HtmlTagDescriptor, Plugin, ViteDevServer } from 'vite'
import { normalizePath } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readConfig } from '../../core/src/client-config.js'
import { dogear } from './index.js'
import { SENTINEL } from './sentinel.js'
import { SOURCE_ATTRIBUTE } from './stamp.js'

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

/** What a run of `configureServer` did, beyond what it returned. */
interface ServerLog {
  readonly warnings: string[]
  readonly infos: string[]
  /** How many middlewares were registered. B6 (#13) asserts this is zero when disabled. */
  readonly middlewares: unknown[]
}

/** The smallest thing `configureServer` reads. Cast, because Vite's type is enormous. */
function fakeServer(serverRoot: string, log: ServerLog): ViteDevServer {
  return {
    config: {
      root: serverRoot,
      logger: {
        warn: (message: string) => log.warnings.push(message),
        info: (message: string) => log.infos.push(message),
      },
    },
    middlewares: {
      use: (handler: unknown) => log.middlewares.push(handler),
    },
  } as unknown as ViteDevServer
}

/** Run `configureServer` and report what it did as well as the plugin it did it to. */
function run(
  options: Parameters<typeof dogear>[0] = {},
  serverRoot = root,
): { plugin: Plugin; log: ServerLog } {
  const log: ServerLog = { warnings: [], infos: [], middlewares: [] }
  const plugin = dogear(options)
  const hook = plugin.configureServer
  if (typeof hook !== 'function') {
    throw new Error('expected configureServer in function form')
  }

  // Vite calls it with the plugin context as `this`; dogear reads none of it.
  ;(hook as (server: ViteDevServer) => void).call(
    plugin as never,
    fakeServer(serverRoot, log),
  )

  return { plugin, log }
}

function configured(
  options: Parameters<typeof dogear>[0] = {},
  serverRoot = root,
): Plugin {
  return run(options, serverRoot).plugin
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
    ).toEqual({ modifier: 'ctrl', endpoint: '/__dogear' })
  })

  it('follows a custom endpoint into the src', () => {
    expect(injectedSrc(configured({ endpoint: '/__x' }))).toContain('/__x/client.js?')
  })

  it('injects nothing when the project turned dogear off — B6 (#13)', () => {
    // Not an inert overlay: no tag, so no bundle reaches a page that asked for none.
    expect(injectedTags(configured({ enabled: false }))).toHaveLength(0)
  })

  it('tells core where to POST — B5 (#12)', () => {
    // Both halves of the same value: the tag's path, and the config core reads its submit
    // target from. They come from one `normaliseEndpoint` call, and they have to agree or a
    // submit 404s into Vite's SPA fallback, which answers 200 with index.html.
    const src = injectedSrc(configured({ endpoint: '/__x/' }))

    expect(src).toContain('/__x/client.js?')
    expect(readConfig(`http://localhost${src}`).endpoint).toBe('/__x')
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

/** B6 (#13) — the repo-wide kill switch. */
describe('enabled: false', () => {
  it('registers no middleware, so no endpoint is served either', () => {
    // The coupling the git-root branch already states: no endpoint means no tag. A tag whose
    // import 404s is a worse failure than absence.
    const { log } = run({ enabled: false })

    expect(log.middlewares).toHaveLength(0)
  })

  it('says so once, on info rather than warn', () => {
    // Nothing is broken and nothing needs attention — this is a state the project chose.
    const { log } = run({ enabled: false })

    expect(log.infos).toHaveLength(1)
    expect(log.infos[0]).toContain('disabled by config')
    expect(log.warnings).toHaveLength(0)
  })

  it('registers the middleware normally when enabled', () => {
    expect(run().log.middlewares).toHaveLength(1)
    expect(run({ enabled: true }).log.middlewares).toHaveLength(1)
  })

  it('does not throw on a bad endpoint it will never use', () => {
    // Checked before `normaliseEndpoint`, deliberately: a project that has turned dogear off
    // should not be able to have its dev server taken down by a dogear misconfiguration.
    expect(() => run({ enabled: false, endpoint: '/' })).not.toThrow()
    // And the same endpoint still throws when dogear is on, so the guard has not been lost.
    expect(() => run({ endpoint: '/' })).toThrow(/endpoint must be a path/)
  })

  it('does not throw on a bad modifier it will never use', () => {
    expect(() => run({ enabled: false, modifier: 'ctr1' as never })).not.toThrow()
  })
})

/**
 * C1 (#15) — the wiring only. Everything the transform *decides* lives in `stampSource` and
 * is tested against fixture strings in ./stamp.test.ts; what is left here is the question
 * this hook actually answers, which is whether to call it at all.
 */
describe('transform (C1)', () => {
  const JSX = 'const a = <div />\n'

  /** An id under the fixture's git root, in the forward-slash form Vite hands plugins. */
  function id(relative: string): string {
    return normalizePath(join(root, relative))
  }

  function transformed(plugin: Plugin, moduleId: string, code = JSX): string | null {
    const hook = plugin.transform
    if (typeof hook !== 'function') {
      throw new Error('expected transform in function form')
    }

    // Same narrowing as `injectedTags` above, and for the same reason: Vite declares a
    // plugin-context `this` and a third options parameter that dogear does not read.
    const call = hook as unknown as (
      code: string,
      moduleId: string,
    ) => { code: string } | null

    return call.call(plugin as never, code, moduleId)?.code ?? null
  }

  it('stamps a .tsx file under the git root', () => {
    expect(transformed(configured(), id('src/App.tsx'))).toContain(
      `${SOURCE_ATTRIBUTE}="src/App.tsx:1:11"`,
    )
  })

  it('stamps .jsx too', () => {
    expect(transformed(configured(), id('src/App.jsx'))).toContain(SOURCE_ATTRIBUTE)
  })

  it.each([
    { what: 'a .ts file', file: 'src/thing.ts' },
    { what: 'a .js file', file: 'src/thing.js' },
    { what: 'a dependency', file: 'node_modules/lib/index.tsx' },
  ])('leaves $what alone', ({ file }) => {
    // The default include is JSX-only and the default exclude covers node_modules. A `.js`
    // holding JSX gets the selector floor (C3) instead, exactly as the brief says.
    expect(transformed(configured(), id(file))).toBeNull()
  })

  it('skips virtual modules', () => {
    // A leading NUL means the id is a plugin's private namespace rather than a path on
    // disk, so there is nothing an agent could open even when the contents are JSX.
    expect(transformed(configured(), `\0${id('src/App.tsx')}`)).toBeNull()
  })

  it('honours a custom include', () => {
    // Narrowed to .jsx, so .tsx now falls outside it. Both are extensions Oxc parses as
    // JSX — an invented extension would pass whether or not the filter was ever consulted,
    // since the parse would fail on its own.
    const plugin = configured({ include: ['**/*.jsx'] })

    expect(transformed(plugin, id('src/App.jsx'))).toContain(SOURCE_ATTRIBUTE)
    expect(transformed(plugin, id('src/App.tsx'))).toBeNull()
  })

  it('honours a custom exclude', () => {
    const plugin = configured({ exclude: ['**/generated/**'] })

    expect(transformed(plugin, id('src/generated/A.tsx'))).toBeNull()
    // The positive control, so the assertion above cannot pass by excluding everything.
    expect(transformed(plugin, id('src/A.tsx'))).toContain(SOURCE_ATTRIBUTE)
  })

  it('resolves relative include patterns against the git root, not cwd', () => {
    // Left to itself `createFilter` resolves against `process.cwd()`, which is wherever npm
    // started the dev server — in a workspace that is the package directory, not the repo.
    // A pattern written relative to the repo has to mean the repo, or a monorepo's shared
    // packages silently stop being stamped.
    const plugin = configured({ include: ['src/**/*.tsx'] })

    expect(transformed(plugin, id('src/App.tsx'))).toContain(SOURCE_ATTRIBUTE)
    expect(transformed(plugin, id('other/App.tsx'))).toBeNull()
  })

  it('stamps nothing when transform: false — the source-resolution axis', () => {
    // Separate from `enabled`: the overlay still injects and still submits, annotations
    // just fall back to the selector floor, as they do in a Vue or Svelte app.
    const plugin = configured({ transform: false })

    expect(transformed(plugin, id('src/App.tsx'))).toBeNull()
    expect(injectedTags(plugin)).toHaveLength(1)
  })

  it('stamps nothing when dogear is disabled', () => {
    expect(transformed(configured({ enabled: false }), id('src/App.tsx'))).toBeNull()
  })

  it('stamps nothing before configureServer has run', () => {
    // The state every plugin object starts in, and why `stamping` is undefined rather than
    // built in the factory — the git root is not known until a server exists.
    expect(transformed(dogear(), id('src/App.tsx'))).toBeNull()
  })

  it('stamps nothing when there is no git root', () => {
    // The same coupling the injection branch states. An attribute naming a path relative to
    // a repository dogear could not find is worse than no attribute.
    const outside = mkdtempSync(join(tmpdir(), 'dogear-nogit-'))

    try {
      expect(
        transformed(configured({}, outside), normalizePath(join(outside, 'src/App.tsx'))),
      ).toBeNull()
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
