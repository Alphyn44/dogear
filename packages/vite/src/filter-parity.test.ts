import { resolve } from 'node:path'

import type { Patterns } from 'dogear-host/filter'
import { createFilter as hostFilter } from 'dogear-host/filter'
import { createFilter as viteFilter } from 'vite'
import { describe, expect, it } from 'vitest'

/**
 * `dogear-host/filter` against the `createFilter` this plugin really uses. J2 (#78).
 *
 * `dogear-next` cannot import Vite, so it filters with a port, and J2's criterion "the files
 * stamped are the ones the configuration includes, as under Vite" is a claim about two
 * implementations agreeing. This file is where that claim is checked, and it lives here rather
 * than in `dogear-host` because the host may not import `vite`, even in a test. A Vite upgrade
 * that changes how `createFilter` matches fails here, which is the moment to decide whether the
 * port follows.
 *
 * Both filters get the same root and patterns, and each id is asked of both. The root carries
 * a space and parentheses on purpose: it is spliced into a glob, and an unescaped `(` is an
 * extglob.
 */

const ROOT = resolve('/work/My App (old)')
const POSIX_ROOT = ROOT.replace(/\\/g, '/')

const CONFIGS: readonly {
  readonly name: string
  readonly include?: Patterns
  readonly exclude?: Patterns
}[] = [
  {
    name: 'the defaults',
    include: ['**/*.jsx', '**/*.tsx'],
    exclude: ['**/node_modules/**'],
  },
  { name: 'a relative include', include: 'src/**/*.tsx' },
  { name: 'a ./-prefixed include', include: './src/**' },
  { name: 'a brace include', include: ['src/**/*.{jsx,tsx}'] },
  { name: 'an absolute include', include: [`${POSIX_ROOT}/lib/**/*.jsx`] },
  { name: 'exclude alone', exclude: ['**/generated/**'] },
  {
    name: 'a relative exclude of one file',
    include: '**/*.tsx',
    exclude: 'src/Skip.tsx',
  },
  { name: 'nothing at all' },
]

const RELATIVE_IDS = [
  'src/App.tsx',
  'src/App.jsx',
  'src/App.tsx?t=1739',
  'other/App.tsx',
  'lib/deep/B.jsx',
  'src/generated/A.tsx',
  'src/Skip.tsx',
  'src/node_modules/x/A.tsx',
  'node_modules/pkg/A.tsx',
  '.storybook/Preview.tsx',
]

/** Each id twice: the forward-slash form Vite hands a plugin, and the native form a loader gets. */
const IDS = [
  ...RELATIVE_IDS.flatMap((id) => [`${POSIX_ROOT}/${id}`, resolve(ROOT, id)]),
  `\0${POSIX_ROOT}/src/Virtual.tsx`,
  resolve('/elsewhere/src/App.tsx'),
]

describe('dogear-host/filter agrees with Vite’s createFilter', () => {
  describe.each(CONFIGS)('with $name', ({ include, exclude }) => {
    const ours = hostFilter(include, exclude, { resolve: ROOT })
    // Vite's types want a mutable array; the values are the same.
    const theirs = viteFilter(
      include as string | string[] | undefined,
      exclude as string | string[] | undefined,
      { resolve: ROOT },
    )

    it.each(IDS)('on %s', (id) => {
      expect(ours(id)).toBe(theirs(id))
    })
  })

  it('is not agreeing vacuously: the table produces both answers', () => {
    // A filter that rejected everything would agree with a broken one everywhere. The defaults
    // must stamp a component and skip a dependency, under both path forms.
    const ours = hostFilter(['**/*.jsx', '**/*.tsx'], ['**/node_modules/**'], {
      resolve: ROOT,
    })

    expect(ours(`${POSIX_ROOT}/src/App.tsx`)).toBe(true)
    expect(ours(resolve(ROOT, 'src/App.tsx'))).toBe(true)
    expect(ours(`${POSIX_ROOT}/node_modules/pkg/A.tsx`)).toBe(false)
    expect(ours(resolve(ROOT, 'node_modules/pkg/A.tsx'))).toBe(false)
  })
})
