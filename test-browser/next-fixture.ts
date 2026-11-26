import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REPO_ROOT,
  discard,
  manifestOf,
  packAll,
  runNpm,
  startNext,
  tarballFor,
} from '../test-packed/fixture.js'
import type { Running } from '../test-packed/fixture.js'

/**
 * The scaffolding for J6 (#82): a Next app installed from packed tarballs, driven through
 * `next dev` under each bundler with stamping on and off.
 *
 * **Why this installs, when H3's Vite leg beside it does not.** J6's fourth criterion is that
 * the packages under test come from packed tarballs rather than workspace links, which is H1's
 * install, registry included. That is allowed here because this suite runs as ci.yml's
 * `browser` job and never inside verify.yml, which release.yml gates on.
 *
 * **Why under `tmpdir`, when J3's `next dev` suite had to live inside the package.** J3's copy
 * reaches the workspace's modules through H3's junction, and `next` realpaths through it into
 * this repository, outside the root Turbopack will read. An install puts real files in the
 * project's own `node_modules`, so the root Turbopack infers (the copy's own `.git`) contains
 * everything it reads, and the copy can sit wherever `findGitRoot` cannot walk into this
 * repository.
 *
 * **One install for every leg.** Installing `next` dominates the run. The legs take turns in
 * one project instead: {@link useLeg} rewrites `next.config.mjs` and clears the queue before
 * each, and each leg builds into a `distDir` of its own, so two bundlers never share a cache.
 */

/** This file lives in `test-browser/`. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The committed fixture app, copied into the scratch root. */
export const NEXT_APP_SOURCE = join(HERE, 'next-app')

/** What the suite packs, and why each one is there. */
const PACKS = [
  // `dogear-next` depends on `dogear-core` by range, and installing the two tarballs together
  // is what lets the local core satisfy it instead of the registry (H1's note on the same).
  'core',
  'next',
] as const

/**
 * The build outputs the packed tarballs carry. `npm pack` packs what is on disk and neither
 * package has a prepack script, so without these the suite would install empty packages and
 * fail as "no annotation arrived", naming the wrong thing.
 */
const REQUIRED_BUILDS = [
  join('packages', 'core', 'dist', 'client.js'),
  join('packages', 'next', 'dist', 'index.js'),
  join('packages', 'next', 'dist', 'loader.js'),
] as const

export function requireNextBuild(): void {
  const missing = REQUIRED_BUILDS.filter((path) => !existsSync(join(REPO_ROOT, path)))
  if (missing.length === 0) return

  throw new Error(
    `the Next suite packs the built packages and ${missing.join(', ')} ` +
      'is missing. Run `npm run build` first.',
  )
}

/**
 * A Next app under `tmpdir`, with its own git root and `dogear-core` and `dogear-next`
 * installed from their tarballs.
 *
 * `realpathSync.native` for the reason `createScratchProject` in ../test-packed/fixture.ts
 * gives at length: on the Windows runner `tmpdir()` is an 8.3 short name, and a dev server
 * watching it is killed by libuv on the first file event.
 */
export async function createNextProject(): Promise<string> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dogear-browser-next-')))

  // A bare `.git` directory rather than a real repository: `findGitRoot` only looks for the
  // entry. It is also where Turbopack bounds its root, which is what this project wants.
  mkdirSync(join(root, '.git'))

  cpSync(NEXT_APP_SOURCE, root, { recursive: true })

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dogear-next-browser-fixture',
        private: true,
        version: '0.0.0',
        type: 'module',
      },
      null,
      2,
    )}\n`,
  )

  // Outside the project, so `next dev` never watches the tarballs and the install never
  // records them. Removed as soon as the install has read them.
  const tarballs = mkdtempSync(join(tmpdir(), 'dogear-browser-next-packs-'))

  try {
    const packed = await packAll(tarballs, PACKS)

    // Read rather than written down, as H1 reads dogear-vite's `vite` peer: a peer bump in the
    // manifest reaches this suite on its own, and CI tests the newest 16.x a user would get.
    const next = manifestOf('next').peerDependencies?.['next']
    if (next === undefined) throw new Error('dogear-next declares no next peerDependency')

    await runNpm(
      [
        'install',
        '--no-save',
        '--no-audit',
        '--no-fund',
        ...PACKS.map((dir) => tarballFor(packed, dir)),
        `next@${next}`,
        'react@^19',
        'react-dom@^19',
      ],
      root,
    )
  } finally {
    discard(tarballs)
  }

  return root
}

export type Bundler = 'turbopack' | 'webpack'

export interface Leg {
  readonly bundler: Bundler
  /**
   * What to pass to `withDogear(…, { transform })`. `false` is the negative leg: the overlay
   * still loads and annotations still arrive, located by C3's floor with no attribute site.
   */
  readonly stamp: boolean
}

/**
 * Point the project at one leg: its config, and an empty queue.
 *
 * **`distDir` per leg** so the bundlers never read each other's output, and so a leg with
 * stamping off cannot be served a page the stamping leg compiled. **`agentRules: false`**
 * because `next dev` writes an `AGENTS.md` when it detects an agent running it (J1's spike, as
 * narrowed by J5), which this suite has no interest in.
 *
 * The queue is deleted, not emptied, so every leg starts from "nothing has been written" and a
 * leg's assertions can only see its own annotations.
 */
export function useLeg(root: string, { bundler, stamp }: Leg): void {
  const distDir = `.next-${bundler}-${stamp ? 'on' : 'off'}`

  writeFileSync(
    join(root, 'next.config.mjs'),
    [
      "import { withDogear } from 'dogear-next'",
      '',
      'export default withDogear(',
      `  { distDir: ${JSON.stringify(distDir)}, agentRules: false },`,
      `  { transform: ${String(stamp)} },`,
      ')',
      '',
    ].join('\n'),
  )

  rmSync(join(root, '.dogear', 'queue.json'), { force: true })
}

/** `next dev` for a leg, from the project's own install. Webpack is the opt-in since Next 16. */
export function startNextDev(root: string, bundler: Bundler): Promise<Running> {
  return startNext(
    root,
    ['dev', ...(bundler === 'webpack' ? ['--webpack'] : [])],
    join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
  )
}
