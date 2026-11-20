import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createEndpoint,
  DEFAULT_ENDPOINT,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
} from 'dogear-host'
import { queuePathFor, readQueue } from 'dogear-queue'
import type { NextConfig } from 'next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withDogear, type NextConfigInput } from './index.js'
import { stopEndpointServers } from './server.js'

/**
 * `withDogear` without Next, for J3 (#79).
 *
 * Everything here calls the returned function the way Next does, `(phase, { defaultConfig })`,
 * and then talks to the loopback server over real HTTP at the port the rewrite names. What a
 * real `next dev` adds, its proxy and its double evaluation, is
 * ../test-built/next-dev.test.ts's job.
 */

const DEV = 'phase-development-server'
const CONTEXT = { defaultConfig: {} }

type Rule = { source: string; destination: string; basePath?: false }
type Resolved = { beforeFiles?: Rule[]; afterFiles?: Rule[]; fallback?: Rule[] }

let root: string
let app: string

beforeEach(() => {
  // A repository with an app below its root, as in a monorepo. `cwd` is the app, which is
  // what `npm run dev` gives Next.
  root = mkdtempSync(join(tmpdir(), 'dogear-next-'))
  mkdirSync(join(root, '.git'))
  app = join(root, 'apps', 'web')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@acme/web' }))
  vi.spyOn(process, 'cwd').mockReturnValue(app)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopEndpointServers()
  rmSync(root, { recursive: true, force: true })
})

async function inDev(
  config: NextConfigInput = {},
  options: Parameters<typeof withDogear>[1] = {},
): Promise<NextConfig> {
  return withDogear(config, options)(DEV, CONTEXT)
}

async function rewritesOf(config: NextConfig): Promise<Resolved> {
  const { rewrites } = config
  if (typeof rewrites !== 'function')
    throw new Error('expected rewrites to be a function')
  return (await rewrites()) as Resolved
}

/** dogear's rule, and the loopback base URL its destination names. */
async function endpointOf(config: NextConfig): Promise<{ rule: Rule; base: string }> {
  const rule = (await rewritesOf(config)).beforeFiles?.[0]
  if (rule === undefined) throw new Error('expected a beforeFiles rule')
  return { rule, base: new URL(rule.destination).origin }
}

function submit(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${DEFAULT_ENDPOINT}/annotations`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const ONE = { version: 1, batch: [{ comment: 'from next' }] }

describe('the phase gate', () => {
  it.each([
    'phase-production-build',
    'phase-production-server',
    'phase-export',
    'phase-test',
    'phase-info',
  ])('returns the user config itself, untouched, in %s', async (phase) => {
    // The same object, not an equal one: outside `next dev` the wrapper contributes nothing,
    // and `next start` evaluating the config in `phase-production-server` is the case that
    // would wire an endpoint into production if this were "not building" instead.
    const config: NextConfig = { reactStrictMode: true }

    await expect(withDogear(config)(phase, CONTEXT)).resolves.toBe(config)
  })

  it('starts nothing outside the dev phase', async () => {
    await withDogear({})('phase-production-server', CONTEXT)

    expect(console.log).not.toHaveBeenCalled()
  })

  it('calls a function config with the phase and context, in every phase', async () => {
    const user = vi.fn((_phase: string, _context: unknown) => ({
      poweredByHeader: false,
    }))

    const built = await withDogear(user)('phase-production-build', CONTEXT)
    const dev = await withDogear(user)(DEV, CONTEXT)

    expect(user).toHaveBeenNthCalledWith(1, 'phase-production-build', CONTEXT)
    expect(user).toHaveBeenNthCalledWith(2, DEV, CONTEXT)
    expect(built).toEqual({ poweredByHeader: false })
    expect(dev.poweredByHeader).toBe(false)
  })

  it('awaits an async function config', async () => {
    const dev = await inDev(async () => ({ trailingSlash: true }))

    expect(dev.trailingSlash).toBe(true)
    expect(dev.rewrites).toBeTypeOf('function')
  })
})

describe('the rewrite', () => {
  it('sends the endpoint to the loopback server, ahead of the filesystem', async () => {
    const { rule } = await endpointOf(await inDev())

    expect(rule.source).toBe(`${DEFAULT_ENDPOINT}/:path*`)
    expect(rule.destination).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+${DEFAULT_ENDPOINT}/:path\\*$`),
    )
    // The overlay POSTs to an absolute path that knows nothing of the app's basePath.
    expect(rule.basePath).toBe(false)
  })

  it('uses a configured endpoint for both ends of the rule', async () => {
    const { rule } = await endpointOf(await inDev({}, { endpoint: '/__x/' }))

    expect(rule.source).toBe('/__x/:path*')
    expect(rule.destination).toMatch(/\/__x\/:path\*$/)
  })

  const userRule: Rule = { source: '/old', destination: '/new' }

  it.each([
    {
      shape: 'no rewrites',
      rewrites: undefined,
      expected: (ours: Rule) => ({ beforeFiles: [ours] }),
    },
    {
      shape: 'a bare array, which Next treats as afterFiles',
      rewrites: [userRule],
      expected: (ours: Rule) => ({ beforeFiles: [ours], afterFiles: [userRule] }),
    },
    {
      shape: 'a function returning an array',
      rewrites: async () => [userRule],
      expected: (ours: Rule) => ({ beforeFiles: [ours], afterFiles: [userRule] }),
    },
    {
      shape: 'a function returning all three phases',
      rewrites: async () => ({
        beforeFiles: [userRule],
        afterFiles: [userRule],
        fallback: [userRule],
      }),
      expected: (ours: Rule) => ({
        beforeFiles: [ours, userRule],
        afterFiles: [userRule],
        fallback: [userRule],
      }),
    },
    {
      shape: 'a plain object with only fallback',
      rewrites: { fallback: [userRule] },
      expected: (ours: Rule) => ({ beforeFiles: [ours], fallback: [userRule] }),
    },
  ] as const)('keeps every user rule given $shape', async ({ rewrites, expected }) => {
    const config = await inDev({ rewrites } as NextConfig)
    const resolved = await rewritesOf(config)
    const ours = resolved.beforeFiles?.[0]

    expect(ours?.source).toBe(`${DEFAULT_ENDPOINT}/:path*`)
    expect(resolved).toEqual(expected(ours as Rule))
  })

  it('keeps the rest of the user config', async () => {
    const config = await inDev({ reactStrictMode: true, basePath: '/docs' })

    expect(config).toMatchObject({ reactStrictMode: true, basePath: '/docs' })
  })
})

describe('the endpoint behind it', () => {
  it('writes to the git root, tagged with the app and the forwarded origin', async () => {
    const { base } = await endpointOf(await inDev())

    const response = await submit(base, ONE, { 'x-forwarded-host': 'localhost:3000' })

    expect(response.status).toBe(200)
    // The git root, two levels above the app `cwd`, not `<app>/.dogear`.
    expect(existsSync(join(app, '.dogear'))).toBe(false)
    const [item] = readQueue(queuePathFor(root)).items
    expect(item).toMatchObject({
      comment: 'from next',
      app: '@acme/web',
      origin: 'http://localhost:3000',
    })
  })

  it('prefers the app option over the nearest package.json', async () => {
    const { base } = await endpointOf(await inDev({}, { app: '  @acme/storefront  ' }))

    await submit(base, ONE)

    expect(readQueue(queuePathFor(root)).items[0]?.['app']).toBe('@acme/storefront')
  })

  it.each([
    { why: 'malformed JSON', body: '{ not json' },
    { why: 'the wrong version', body: { version: 2, batch: [{ comment: 'x' }] } },
    { why: 'an empty comment', body: { version: 1, batch: [{ comment: '' }] } },
  ])('refuses $why with a 400 and writes nothing (A2)', async ({ body }) => {
    const { base } = await endpointOf(await inDev())

    expect((await submit(base, body)).status).toBe(400)
    expect(existsSync(queuePathFor(root))).toBe(false)
  })

  it('answers with dogear’s own 404 for an unknown path under the base', async () => {
    const { base } = await endpointOf(await inDev())

    const response = await fetch(`${base}${DEFAULT_ENDPOINT}/nope`)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ ok: false })
  })
})

describe('once per process', () => {
  it('starts one server however many times the config is evaluated', async () => {
    // Turbopack's dev server evaluates next.config twice in one process. A second server
    // would be a listener the first evaluation's rewrite never reaches.
    const first = await endpointOf(await inDev())
    const second = await endpointOf(await inDev())

    expect(second.base).toBe(first.base)
  })

  it('prints its ready line once, not once per evaluation', async () => {
    await inDev()
    await inDev()

    const ready = vi
      .mocked(console.log)
      .mock.calls.filter(([line]) => String(line).startsWith('[dogear] ready'))
    expect(ready).toHaveLength(1)
  })

  it('starts a separate server for a different endpoint', async () => {
    const first = await endpointOf(await inDev())
    const other = await endpointOf(await inDev({}, { endpoint: '/__other' }))

    expect(other.base).not.toBe(first.base)
  })
})

describe('staying out of the way', () => {
  it('leaves the config untouched with enabled: false, before reading anything', async () => {
    // A bad endpoint alongside it must not throw: a disabled project cannot be stopped by a
    // dogear misconfiguration it will never use.
    const config: NextConfig = { reactStrictMode: true }

    await expect(inDev(config, { enabled: false, endpoint: '/' })).resolves.toBe(config)
  })

  it('leaves the config untouched when .dogear/config.json says enabled: false', async () => {
    mkdirSync(join(root, '.dogear'))
    writeFileSync(
      join(root, '.dogear', 'config.json'),
      JSON.stringify({ version: 1, enabled: false }),
    )
    const config: NextConfig = {}

    await expect(inDev(config)).resolves.toBe(config)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('config.json'))
  })

  it('lets the option beat the file', async () => {
    mkdirSync(join(root, '.dogear'))
    writeFileSync(
      join(root, '.dogear', 'config.json'),
      JSON.stringify({ version: 1, enabled: false }),
    )

    const config = await inDev({}, { enabled: true })

    expect(config.rewrites).toBeTypeOf('function')
  })

  it('takes its endpoint from the file when the option is unset', async () => {
    mkdirSync(join(root, '.dogear'))
    writeFileSync(
      join(root, '.dogear', 'config.json'),
      JSON.stringify({ version: 1, endpoint: '/__fromfile' }),
    )

    const { rule } = await endpointOf(await inDev())

    expect(rule.source).toBe('/__fromfile/:path*')
  })

  it('warns and stays inert outside a git repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dogear-next-nogit-'))
    vi.mocked(process.cwd).mockReturnValue(outside)
    const config: NextConfig = {}

    try {
      await expect(inDev(config)).resolves.toBe(config)
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no .git found'))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('throws on a bad endpoint option, as the Vite plugin does', async () => {
    await expect(inDev({}, { endpoint: '//evil.com' })).rejects.toThrow(
      /protocol-relative/,
    )
  })
})

/**
 * J2 (#78): the loader, as `withDogear` registers it. What each bundler then hands the loader is
 * ../test-built/next-dev.test.ts's job; what the loader does with it is ./loader.test.ts's.
 */
describe('source stamping', () => {
  type LoaderItem = { loader: string; options: Record<string, unknown> }
  type TurbopackRule = { loaders: LoaderItem[]; condition: unknown; as?: string }
  type WebpackRule = { test: RegExp; exclude: RegExp; enforce: string; use: LoaderItem[] }

  const WEBPACK_CONTEXT = { isServer: false }

  function turbopackRules(config: NextConfig): Record<string, unknown> {
    return (config.turbopack?.rules ?? {}) as Record<string, unknown>
  }

  /** Run the config's `webpack()` the way Next does, and return the rules it leaves. */
  function webpackRules(config: NextConfig, base: object = { module: { rules: [] } }) {
    if (typeof config.webpack !== 'function')
      throw new Error('expected a webpack function')
    const out = config.webpack(base, WEBPACK_CONTEXT as never) as {
      module: { rules: unknown[] }
    }
    return out.module.rules
  }

  function ourWebpackRule(config: NextConfig): WebpackRule {
    return webpackRules(config).at(-1) as WebpackRule
  }

  function writeConfigFile(contents: object): void {
    mkdirSync(join(root, '.dogear'), { recursive: true })
    writeFileSync(
      join(root, '.dogear', 'config.json'),
      JSON.stringify({ version: 1, ...contents }),
    )
  }

  it('registers one loader under Turbopack for .jsx and .tsx, outside node_modules', async () => {
    const rules = turbopackRules(await inDev())

    expect(Object.keys(rules).sort()).toEqual(['*.jsx', '*.tsx'])
    for (const rule of Object.values(rules) as TurbopackRule[]) {
      expect(rule).toEqual({
        loaders: [
          {
            loader: expect.stringMatching(/[\\/]loader\.js$/),
            options: {
              gitRoot: root,
              include: DEFAULT_INCLUDE,
              exclude: DEFAULT_EXCLUDE,
            },
          },
        ],
        condition: { not: 'foreign' },
      })
      // J1's spike: `as` renames the module, and this loader's output keeps its file type.
      expect(rule).not.toHaveProperty('as')
    }
  })

  it('registers the same loader under webpack, as a pre loader for .jsx and .tsx', async () => {
    const config = await inDev()
    const rule = ourWebpackRule(config)
    const [turbopackLoader] = (turbopackRules(config)['*.tsx'] as TurbopackRule).loaders

    expect(rule.enforce).toBe('pre')
    expect(rule.use).toEqual([turbopackLoader])
    expect(
      ['App.tsx', 'App.jsx', 'App.ts', 'App.js'].map((f) => rule.test.test(f)),
    ).toEqual([true, true, false, false])
    expect(rule.exclude.test('/repo/node_modules/pkg/A.tsx')).toBe(true)
    expect(rule.exclude.test('C:\\repo\\node_modules\\pkg\\A.tsx')).toBe(true)
    expect(rule.exclude.test('/repo/src/A.tsx')).toBe(false)
  })

  it('passes options that survive JSON, which is all a Turbopack worker receives', async () => {
    const { options } = (turbopackRules(await inDev())['*.tsx'] as TurbopackRule)
      .loaders[0]!

    expect(JSON.parse(JSON.stringify(options))).toEqual(options)
  })

  it.each([
    {
      layer: 'the defaults',
      file: {},
      options: {},
      expected: { include: DEFAULT_INCLUDE, exclude: DEFAULT_EXCLUDE },
    },
    {
      layer: 'the file over the defaults',
      file: { include: 'src/**/*.tsx', exclude: ['**/gen/**'] },
      options: {},
      expected: { include: 'src/**/*.tsx', exclude: ['**/gen/**'] },
    },
    {
      layer: 'the option over the file',
      file: { include: 'src/**/*.tsx', exclude: ['**/gen/**'] },
      options: { include: ['app/**/*.tsx'], exclude: [] },
      expected: { include: ['app/**/*.tsx'], exclude: [] },
    },
  ])('layers include and exclude: $layer', async ({ file, options, expected }) => {
    writeConfigFile(file)

    const { loaders } = turbopackRules(await inDev({}, options))['*.jsx'] as TurbopackRule

    expect(loaders[0]?.options).toMatchObject(expected)
  })

  it.each([
    { why: 'the transform: false option', file: {}, options: { transform: false } },
    { why: 'transform: false in the file', file: { transform: false }, options: {} },
  ])(
    'registers no loader for $why, and keeps the endpoint',
    async ({ file, options }) => {
      writeConfigFile(file)

      const config = await inDev({ webpack: null }, options)

      expect(config.turbopack).toBeUndefined()
      expect(config.webpack).toBeNull()
      expect(config.rewrites).toBeTypeOf('function')
    },
  )

  it('lets transform: true in the option beat the file', async () => {
    writeConfigFile({ transform: false })

    expect(
      Object.keys(turbopackRules(await inDev({}, { transform: true }))),
    ).toHaveLength(2)
  })

  it('registers nothing outside the dev phase', async () => {
    // The same-object assertion in "the phase gate" already covers this; restated here so
    // the stamping criterion "nothing in a next build carries it" has a unit-level witness.
    const built = await withDogear({})('phase-production-build', CONTEXT)

    expect(built.turbopack).toBeUndefined()
    expect(built.webpack).toBeUndefined()
  })

  describe('alongside the user’s Turbopack rules', () => {
    const userLoader = { loader: 'user-loader', options: { a: 1 } }

    it('keeps the rest of the turbopack block and every other glob', async () => {
      const config = await inDev({
        turbopack: {
          root: '/somewhere',
          resolveAlias: { a: 'b' },
          rules: { '*.svg': { loaders: ['@svgr/webpack'], as: '*.js' } },
        },
      })

      expect(config.turbopack).toMatchObject({
        root: '/somewhere',
        resolveAlias: { a: 'b' },
        rules: { '*.svg': { loaders: ['@svgr/webpack'], as: '*.js' } },
      })
    })

    it.each([
      {
        shape: 'one rule object',
        theirs: { loaders: [userLoader], condition: 'browser' },
        expected: [{ loaders: [userLoader], condition: 'browser' }],
      },
      {
        shape: 'the shorthand list of loaders, wrapped as the one rule it is',
        theirs: ['plain-loader', userLoader],
        expected: [{ loaders: ['plain-loader', userLoader] }],
      },
      {
        shape: 'a list of rules',
        theirs: [
          { loaders: [userLoader], condition: 'browser' },
          { loaders: ['plain-loader'], condition: { not: 'browser' } },
        ],
        expected: [
          { loaders: [userLoader], condition: 'browser' },
          { loaders: ['plain-loader'], condition: { not: 'browser' } },
        ],
      },
    ])('puts ours first, ahead of $shape', async ({ theirs, expected }) => {
      const config = await inDev({
        turbopack: { rules: { '*.tsx': theirs } },
      } as NextConfig)
      const rules = turbopackRules(config)

      const [ours, ...rest] = rules['*.tsx'] as TurbopackRule[]
      expect(ours?.loaders[0]?.loader).toMatch(/[\\/]loader\.js$/)
      expect(rest).toEqual(expected)
      // The glob the user did not touch gets ours alone.
      expect(Array.isArray(rules['*.jsx'])).toBe(false)
    })
  })

  describe('alongside the user’s webpack()', () => {
    it('calls theirs first, with the config and context, and adds ours last', async () => {
      const user = vi.fn(
        (config: { module: { rules: unknown[] } }, _context: unknown) => {
          config.module.rules.push('theirs')
          return config
        },
      )

      const config = await inDev({ webpack: user })
      const rules = webpackRules(config)

      expect(user).toHaveBeenCalledWith(expect.anything(), WEBPACK_CONTEXT)
      expect(rules[0]).toBe('theirs')
      expect(rules).toHaveLength(2)
      expect((rules[1] as WebpackRule).enforce).toBe('pre')
    })

    it('uses the object theirs returns, even a new one', async () => {
      const replaced = { module: { rules: ['replaced'] }, marker: true }

      const config = await inDev({ webpack: () => replaced })
      const out = config.webpack!({ module: { rules: [] } }, WEBPACK_CONTEXT as never)

      expect(out).toBe(replaced)
      expect(replaced.module.rules).toHaveLength(2)
    })

    it('creates module.rules when the config has none', async () => {
      const rules = webpackRules(await inDev(), {})

      expect(rules).toHaveLength(1)
    })
  })
})

/**
 * AC2: a Next dev server and a Vite dev server in one repository write to one queue, and
 * concurrent submits lose nothing.
 *
 * The Vite side is `createEndpoint` as `dogear-vite` mounts it, with no `forwarded` flag,
 * over the same git root. **Honest limit, C4's:** both share a pid and an event loop, so this
 * pins read-modify-write, not a cross-process interleave. That race is the brief's Still open
 * "queue lock", deliberately unbuilt, and J3 reads this criterion as C4 did.
 */
describe('a Next server and a Vite server, one queue', () => {
  let vite: Server

  afterEach(async () => {
    await new Promise<void>((resolve) => vite.close(() => resolve()))
  })

  it('keeps every item from both when they submit at once', async () => {
    const { base: next } = await endpointOf(await inDev())

    const viteHandler = createEndpoint({
      gitRoot: root,
      endpoint: DEFAULT_ENDPOINT,
      clientDist: undefined,
      app: '@acme/admin',
    })
    vite = createServer((req, res) => {
      viteHandler(req, res, () => {
        res.statusCode = 418
        res.end()
      })
    })
    await new Promise<void>((resolve) => vite.listen(0, '127.0.0.1', resolve))
    const viteBase = `http://127.0.0.1:${(vite.address() as AddressInfo).port}`

    const batch = (comment: string) => ({ version: 1, batch: [{ comment }] })
    const responses = await Promise.all([
      submit(next, batch('n1')),
      submit(viteBase, batch('v1')),
      submit(next, batch('n2')),
      submit(viteBase, batch('v2')),
    ])

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200])
    const { items } = readQueue(queuePathFor(root))
    expect(items.map((item) => item['comment']).sort()).toEqual(['n1', 'n2', 'v1', 'v2'])
    expect(new Set(items.map((item) => item['app']))).toEqual(
      new Set(['@acme/web', '@acme/admin']),
    )
  })
})
