import { resolve } from 'node:path'

import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, SENTINEL } from 'dogear-host'
import { SOURCE_ATTRIBUTE } from 'dogear-host/stamp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoaderOptions } from './loader.js'

/**
 * The loader as a bundler calls it, for J2 (#78) and J4 (#80).
 *
 * A fake context stands in for webpack's and Turbopack's, naming only the members the loader
 * declares it uses. The module is re-imported per test, because "warn once per process" is
 * module state and each test is its own process as far as that is concerned.
 *
 * What `transformSource` decides is ../../host/src/stamp.test.ts's; what `withDogear` registers
 * is ./index.test.ts's. This file holds the seam between them: the filter, the path, the two
 * jobs' separate gates and the fallbacks.
 */

const ROOT = resolve('/repo')
const SOURCE = 'export const App = () => <div />\n'
const LAYOUT =
  'export default function RootLayout({ children }) {\n' +
  '  return <html><body>{children}</body></html>\n' +
  '}\n'
const MAP = { version: 3, mappings: '' }
const CLIENT_SRC = '/__dogear/client.js?config=%7B%7D'

const DEFAULTS: LoaderOptions = {
  gitRoot: ROOT,
  stamp: true,
  include: DEFAULT_INCLUDE,
  exclude: DEFAULT_EXCLUDE,
  clientSrc: CLIENT_SRC,
}

interface Run {
  readonly code: string | undefined
  readonly map: unknown
  readonly error: Error | null
  readonly warnings: readonly Error[]
}

let loader: (typeof import('./loader.js'))['default']

beforeEach(async () => {
  vi.resetModules()
  ;({ default: loader } = await import('./loader.js'))
})

function run(
  resourcePath: string,
  options: unknown = DEFAULTS,
  source = SOURCE,
  extra: { rootContext?: string; warnings?: Error[] } = {},
): Run {
  const warnings = extra.warnings ?? []
  let result: Omit<Run, 'warnings'> | undefined

  loader.call(
    {
      resourcePath,
      rootContext: extra.rootContext,
      getOptions: () => options,
      callback: (error, code, map) => {
        result = { error, code, map }
      },
      emitWarning: (warning) => warnings.push(warning),
    },
    source,
    MAP,
  )

  if (result === undefined) throw new Error('the loader never called back')
  return { ...result, warnings }
}

describe('the dogear loader', () => {
  it('stamps an included file, relative to the git root, with a fresh map', () => {
    const { code, map, error } = run(resolve(ROOT, 'app/page.tsx'))

    expect(error).toBeNull()
    expect(code).toContain(`${SOURCE_ATTRIBUTE}="app/page.tsx:1:26"`)
    expect(map).not.toBe(MAP)
    expect(map).toMatchObject({ mappings: expect.any(String) })
  })

  it.each([
    { why: 'a dependency, by the default exclude', path: 'node_modules/ui/Button.tsx' },
    { why: 'a file outside the repository', path: '../elsewhere/App.tsx' },
  ])('passes $why through untouched, with its map', ({ path }) => {
    const { code, map } = run(resolve(ROOT, path))

    expect(code).toBe(SOURCE)
    expect(map).toBe(MAP)
  })

  it('honours a narrowed include, resolved against the git root', () => {
    const options = { ...DEFAULTS, include: 'app/**/*.tsx' }

    expect(run(resolve(ROOT, 'app/page.tsx'), options).code).toContain(SOURCE_ATTRIBUTE)
    expect(run(resolve(ROOT, 'components/Card.tsx'), options).code).toBe(SOURCE)
  })

  it('honours an exclude', () => {
    const options = { ...DEFAULTS, exclude: ['**/generated/**'] }

    expect(run(resolve(ROOT, 'app/generated/A.tsx'), options).code).toBe(SOURCE)
    expect(run(resolve(ROOT, 'app/A.tsx'), options).code).toContain(SOURCE_ATTRIBUTE)
  })

  it('resolves a relative resourcePath against the project root', () => {
    const { code } = run('app/page.tsx', DEFAULTS, SOURCE, { rootContext: ROOT })

    expect(code).toContain(`${SOURCE_ATTRIBUTE}="app/page.tsx:1:26"`)
  })

  it('stamps the same way every time, so webpack’s three layers agree', () => {
    // webpack runs the loader once per layer (rsc, ssr, browser), and a stamp that differed
    // between them would be a hydration mismatch.
    const path = resolve(ROOT, 'app/page.tsx')

    expect(run(path).code).toBe(run(path).code)
  })

  it('passes a file that does not parse through silently, as under Vite', () => {
    const { code, warnings } = run(
      resolve(ROOT, 'app/page.tsx'),
      DEFAULTS,
      'const = <div',
    )

    expect(code).toBe('const = <div')
    expect(warnings).toEqual([])
  })

  it('passes the source through on a failure, and warns once per process', () => {
    // Options with no git root are what a version skew between the wrapper and the loader
    // would look like, and they reach the same catch as any other throw.
    const warnings: Error[] = []
    const broken = { include: DEFAULT_INCLUDE }

    const first = run(resolve(ROOT, 'app/a.tsx'), broken, SOURCE, { warnings })
    const second = run(resolve(ROOT, 'app/b.tsx'), broken, SOURCE, { warnings })

    expect([first.code, second.code]).toEqual([SOURCE, SOURCE])
    expect([first.error, second.error]).toEqual([null, null])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toMatch(/^\[dogear\] could not stamp .*a\.tsx/)
  })
})

describe('the client tag (J4)', () => {
  it('goes into a root layout, alongside its stamps', () => {
    const { code } = run(resolve(ROOT, 'app/layout.tsx'), DEFAULTS, LAYOUT)

    expect(code).toContain(`data-dogear="${SENTINEL}"`)
    expect(code).toContain(`src={${JSON.stringify(CLIENT_SRC)}}`)
    expect(code).toContain(`<body ${SOURCE_ATTRIBUTE}="app/layout.tsx:2:16"`)
  })

  it('goes into a layout.js, which create-next-app --js writes with JSX in it', () => {
    // Outside the default include, so it is not stamped: the tag does not follow the filter.
    const { code } = run(resolve(ROOT, 'app/layout.js'), DEFAULTS, LAYOUT)

    expect(code).toContain(`data-dogear="${SENTINEL}"`)
    expect(code).not.toContain(SOURCE_ATTRIBUTE)
  })

  it('goes in with stamping off', () => {
    const { code } = run(
      resolve(ROOT, 'app/layout.tsx'),
      { ...DEFAULTS, stamp: false },
      LAYOUT,
    )

    expect(code).toContain(`data-dogear="${SENTINEL}"`)
    expect(code).not.toContain(SOURCE_ATTRIBUTE)
  })

  it('goes into a layout the configuration excludes from stamping', () => {
    const options = { ...DEFAULTS, exclude: ['**/app/layout.tsx'] }
    const { code } = run(resolve(ROOT, 'app/layout.tsx'), options, LAYOUT)

    expect(code).toContain(`data-dogear="${SENTINEL}"`)
    expect(code).not.toContain(SOURCE_ATTRIBUTE)
  })

  it('passes a .js file with no <html> and nothing to stamp through untouched', () => {
    // The cheap path every other .js file in an app takes, now that the loader is registered
    // for them all.
    const { code, map } = run(
      resolve(ROOT, 'app/util.js'),
      DEFAULTS,
      'export const a = 1\n',
    )

    expect(code).toBe('export const a = 1\n')
    expect(map).toBe(MAP)
  })

  it('refuses options without a client src, as a version skew', () => {
    const warnings: Error[] = []
    const { clientSrc: _, ...skewed } = DEFAULTS

    const { code } = run(resolve(ROOT, 'app/layout.tsx'), skewed, LAYOUT, { warnings })

    expect(code).toBe(LAYOUT)
    expect(warnings).toHaveLength(1)
  })
})
