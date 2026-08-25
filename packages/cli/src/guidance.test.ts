import { describe, expect, it } from 'vitest'

import type { DetectedApp, Detection, Manager } from './detect.js'
import { guidance } from './guidance.js'

/**
 * What `dogear init` tells you to do yourself — E8 (#41).
 *
 * **A pure function over a `Detection`, so there is no filesystem here at all.** ./detect.test.ts
 * builds real repositories and pins what detection *sees*; this file pins what init *says* about
 * it. Splitting them that way is what makes the awkward cases — five apps, a manifest one
 * directory above its app, a plugin in the wrong dependency map — a literal rather than a fixture
 * built to produce one.
 *
 * The assertions are on whole lines rather than substrings wherever the wording is the point:
 * this block is copied into a config file by hand, and a snippet that is subtly wrong is worse
 * than no snippet, because it will be pasted before it is read.
 */

function app(overrides: Partial<DetectedApp> = {}): DetectedApp {
  return {
    dir: 'apps/web',
    config: 'apps/web/vite.config.ts',
    framework: 'react',
    frameworkVersion: '^19.2.0',
    viteVersion: '^8.2.1',
    manifestDir: 'apps/web',
    plugin: 'absent',
    // The unwired baseline: neither declared nor in the config. G3 (#44) made these two
    // independent, so every case below says which of them it is varying.
    configured: false,
    ...overrides,
  }
}

// `agents` and `cli` are E3's (#28) and guidance() reads neither — it prints the plugin
// install, which is a question about the Vite apps. Spelled out rather than cast so that a
// future field has to be answered here too.
function detection(apps: readonly DetectedApp[], manager: Manager = 'npm'): Detection {
  return {
    workspace: 'npm',
    manager,
    // guidance() reads this no more than it reads `agents` — H6's remark is ./scaffold.ts's.
    linker: 'node-modules',
    packages: apps.length,
    apps,
    agents: [],
    cli: 'local',
  }
}

describe('guidance() when an app is not wired', () => {
  it('names the app’s real config path in the heading', () => {
    const lines = guidance(detection([app({ config: 'apps/web/vite.config.mts' })]))

    expect(lines).toContain('add dogear to apps/web/vite.config.mts:')
  })

  it('prints the import and the plugins entry, exactly as they must be typed', () => {
    expect(guidance(detection([app()]))).toEqual([
      '',
      'add dogear to apps/web/vite.config.ts:',
      '',
      "  import { dogear } from 'dogear-vite'",
      '',
      '  export default defineConfig({',
      '    plugins: [dogear()],',
      '  })',
      '',
      'then, in apps/web: npm i -D dogear-vite',
    ])
  })

  it('opens with a blank line, so the caller does not have to add one', () => {
    // ./scaffold.ts appends this outside the report's indent and adds no separator of its own.
    // An empty block therefore costs nothing, which is what lets the caller concatenate blindly.
    expect(guidance(detection([app()]))[0]).toBe('')
  })

  it('does NOT name the framework in the snippet, even though detection knows it', () => {
    // `plugins: [dogear(), react()]` reads closer to the user's real file and asserts an import
    // that may not exist under that name. A copyable snippet that is subtly wrong is the failure
    // mode here — it gets pasted before it gets read.
    expect(guidance(detection([app()])).join('\n')).not.toContain('react()')
  })
})

describe('guidance() and the install command', () => {
  it.each([
    ['npm', 'then, in apps/web: npm i -D dogear-vite'],
    ['pnpm', 'then, in apps/web: pnpm add -D dogear-vite'],
    ['yarn', 'then, in apps/web: yarn add -D dogear-vite'],
  ] as const)('uses the %s form', (manager, expected) => {
    expect(guidance(detection([app()], manager))).toContain(expected)
  })

  it('always installs as a DEV dependency', () => {
    // The manifest half of the production leak scripts/check-leak.ts exists to catch. A printed
    // command is the one place init can get this wrong at scale — every user copies it.
    for (const manager of ['npm', 'pnpm', 'yarn'] as const) {
      expect(guidance(detection([app()], manager)).join('\n')).toMatch(
        / -D dogear-vite$/m,
      )
    }
  })

  it('points at the package that owns the app, not the app directory', () => {
    // An app scaffolded into a subdirectory of an existing package has no manifest of its own.
    // Naming its directory would tell the user to run an install somewhere that grows a stray
    // package.json — and detection already read the framework from the manifest one level up.
    const nested = app({
      dir: 'apps/web/client',
      config: 'apps/web/client/vite.config.ts',
      manifestDir: 'apps/web',
    })

    expect(guidance(detection([nested]))).toContain(
      'then, in apps/web: npm i -D dogear-vite',
    )
  })

  it('says “at the repo root” for a root manifest rather than naming an empty path', () => {
    expect(guidance(detection([app({ manifestDir: '' })]))).toContain(
      'then, at the repo root: npm i -D dogear-vite',
    )
  })

  it('falls back to the root when there is no manifest anywhere above the app', () => {
    // An install there creates the package.json the repository was always going to need, and it
    // is where the user is standing.
    expect(guidance(detection([app({ manifestDir: undefined })]))).toContain(
      'then, at the repo root: npm i -D dogear-vite',
    )
  })
})

describe('guidance() when there is nothing to say', () => {
  it.each([['dev'], ['runtime']] as const)(
    'is silent for an app whose manifest declares the plugin in %s',
    (plugin) => {
      // `runtime` is wrong and earns a note from ./scaffold.ts — but the import resolves, so
      // telling the user to install a package they already have would be the wrong correction.
      expect(guidance(detection([app({ plugin, configured: true })]))).toEqual([])
    },
  )

  it('is silent on a repository with no apps at all', () => {
    // E2's `note: no vite config found` already covers it. A second line saying the same thing
    // in different words is how a report stops being read.
    expect(guidance(detection([]))).toEqual([])
  })

  it('is silent when every one of several apps is wired', () => {
    const apps = ['a', 'b', 'c'].map((name) =>
      app({
        dir: name,
        config: `${name}/vite.config.ts`,
        manifestDir: name,
        plugin: 'dev',
        configured: true,
      }),
    )

    expect(guidance(detection(apps))).toEqual([])
  })
})

/**
 * The install and the config edit are independent, and G3 (#44) walked into the gap: the
 * package installed, `dogear()` never added, and init silent because it keyed on the manifest
 * alone. Each half now earns exactly the half of the block that is missing.
 */
describe('guidance() when only one half is done', () => {
  it('prints the snippet and no install for an app that has the package', () => {
    const lines = guidance(detection([app({ plugin: 'dev', configured: false })]))

    expect(lines).toContain('add dogear to apps/web/vite.config.ts:')
    expect(lines.join('\n')).not.toContain('npm i -D')
  })

  it('prints the install and no snippet for a config that already calls dogear', () => {
    const lines = guidance(detection([app({ plugin: 'absent', configured: true })]))

    expect(lines).toContain('install it in apps/web: npm i -D dogear-vite')
    expect(lines.join('\n')).not.toContain('add dogear to')
  })

  it('says `then,` only when the install follows a snippet', () => {
    // `then,` reads as a sequel. Standing alone above nothing, it refers to a step that is not
    // there — which is why the lead is chosen from `configured` rather than fixed.
    const both = guidance(detection([app()])).join('\n')

    expect(both).toContain('then, in apps/web: npm i -D dogear-vite')
  })
})

describe('guidance() across several apps', () => {
  /** `n` unwired apps, named `app0`…`appN`. */
  function apps(n: number): readonly DetectedApp[] {
    return Array.from({ length: n }, (_, index) =>
      app({
        dir: `app${index}`,
        config: `app${index}/vite.config.ts`,
        manifestDir: `app${index}`,
      }),
    )
  }

  it('gives every unwired app its own snippet', () => {
    // dogear is per Vite root, so an app without the plugin has no overlay however many of its
    // siblings do. One snippet for the repository would leave the others silently unwired.
    const lines = guidance(detection(apps(3))).join('\n')

    for (const index of [0, 1, 2]) {
      expect(lines).toContain(`add dogear to app${index}/vite.config.ts:`)
    }
  })

  it('skips the wired ones and keeps the rest', () => {
    const mixed = [
      app({
        dir: 'wired',
        config: 'wired/vite.config.ts',
        plugin: 'dev',
        configured: true,
      }),
      ...apps(1),
    ]
    const lines = guidance(detection(mixed)).join('\n')

    expect(lines).not.toContain('wired/vite.config.ts')
    expect(lines).toContain('app0/vite.config.ts')
  })

  it('caps the snippets and counts the remainder', () => {
    // Six snippets is roughly sixty lines above a three-line report. The cap matches E2's.
    const lines = guidance(detection(apps(8)))

    expect(lines.filter((line) => line.startsWith('add dogear to'))).toHaveLength(5)
    expect(lines).toContain('+ 3 more apps need the same')
  })

  it('counts one remaining app in the singular', () => {
    expect(guidance(detection(apps(6)))).toContain('+ 1 more app needs the same')
  })

  it('adds no remainder line when everything fits', () => {
    expect(guidance(detection(apps(5))).join('\n')).not.toContain('more app')
  })
})
