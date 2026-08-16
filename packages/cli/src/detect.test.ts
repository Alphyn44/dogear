import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detect } from './detect.js'

/**
 * What `dogear init` works out about a repository — E2 (#27).
 *
 * **No git repository here, unlike ./scaffold.test.ts.** Detection asks git nothing — it reads
 * manifests and lists directories — so a `mkdtemp` is the whole fixture, and a suite that
 * shelled out to `git init` would be paying for a premise it does not use. ./scaffold.test.ts
 * covers detection's *report*; this file covers what it found.
 *
 * **Every case is a repository shape, not a function call.** The failure this suite exists to
 * catch is a detector confidently describing a layout it misread — which is silent, and which
 * a mocked filesystem would reproduce exactly as wrongly. So the fixtures are real files.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-detect-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

/** Write a file, creating whatever directories it needs. Path is repo-relative and posix. */
function file(path: string, contents: string): void {
  const absolute = join(root, ...path.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

/** A `package.json` with the given dependency maps. */
function manifest(path: string, fields: Record<string, unknown>): void {
  file(path, JSON.stringify(fields))
}

describe('detect() on a single-package repository', () => {
  it('finds the vite config, the framework and both versions', () => {
    manifest('package.json', {
      devDependencies: { vite: '^8.2.1' },
      dependencies: { react: '^19.2.0' },
    })
    file('vite.config.ts', '')

    const { workspace, packages, apps } = detect(root)

    expect(workspace).toBe('single')
    expect(packages).toBeUndefined()
    expect(apps).toEqual([
      {
        dir: '',
        config: 'vite.config.ts',
        framework: 'react',
        frameworkVersion: '^19.2.0',
        viteVersion: '^8.2.1',
        manifestDir: '',
        plugin: 'absent',
      },
    ])
  })

  it('reports the app with no framework rather than dropping it', () => {
    // A vanilla Vite app is a real thing dogear works on — the selector floor does not care
    // what rendered the DOM. Dropping it would report `vite: none found` over a repo that has
    // one, which is the worst answer available.
    manifest('package.json', { devDependencies: { vite: '^8.2.1' } })
    file('vite.config.js', '')

    expect(detect(root).apps).toEqual([
      {
        dir: '',
        config: 'vite.config.js',
        framework: undefined,
        frameworkVersion: undefined,
        viteVersion: '^8.2.1',
        manifestDir: '',
        plugin: 'absent',
      },
    ])
  })

  it.each([
    ['vite.config.js'],
    ['vite.config.mjs'],
    ['vite.config.cjs'],
    ['vite.config.ts'],
    ['vite.config.mts'],
    ['vite.config.cts'],
  ])('recognises %s', (name) => {
    manifest('package.json', {})
    file(name, '')

    expect(detect(root).apps.map((app) => app.config)).toEqual([name])
  })

  it('takes the framework from the nearest manifest above an app that has none', () => {
    // `npm create vite` in a subdirectory of a repo that already had a manifest. The app
    // directory has a config and no `package.json`, and the answer is one level up.
    manifest('package.json', { dependencies: { svelte: '^5.0.0' } })
    file('apps/web/vite.config.ts', '')

    expect(detect(root).apps).toContainEqual(
      expect.objectContaining({ dir: 'apps/web', framework: 'svelte' }),
    )
  })

  it('finds no app in a repository that has no vite config', () => {
    manifest('package.json', { dependencies: { express: '^5.0.0' } })

    const { workspace, apps } = detect(root)

    expect(workspace).toBe('single')
    expect(apps).toEqual([])
  })
})

describe('detect() and the package manager', () => {
  beforeEach(() => {
    manifest('package.json', {})
    file('vite.config.ts', '')
  })

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ])('reads %s as %s', (lockfile, manager) => {
    file(lockfile, '')

    expect(detect(root).manager).toBe(manager)
  })

  it('answers npm when nothing has been installed yet', () => {
    // A fallback rather than a detection. There is no lockfile to read in a repository that has
    // never installed, and npm is the floor this project targets.
    expect(detect(root).manager).toBe('npm')
  })

  it('reports the manager of a SINGLE-package pnpm repo, which the layout cannot', () => {
    // The case that forces `manager` and `workspace` apart. This repo's layout is `single`,
    // which says nothing about the manager at all — and E8 would print `npm i -D` at a pnpm
    // user if it had to read the manager off the layout field.
    file('pnpm-lock.yaml', '')

    expect(detect(root).workspace).toBe('single')
    expect(detect(root).manager).toBe('pnpm')
  })

  it('prefers pnpm over a yarn.lock left behind by a migration', () => {
    file('yarn.lock', '')
    file('pnpm-lock.yaml', '')

    expect(detect(root).manager).toBe('pnpm')
  })
})

describe('detect() and whether the plugin is already declared', () => {
  it.each([
    ['devDependencies', 'dev'],
    ['dependencies', 'runtime'],
  ] as const)('reports @dogear/vite in %s as %s', (field, plugin) => {
    manifest('package.json', { [field]: { '@dogear/vite': '^1.0.0' } })
    file('vite.config.ts', '')

    expect(detect(root).apps[0]?.plugin).toBe(plugin)
  })

  it('reports absent when nothing declares it', () => {
    manifest('package.json', { devDependencies: { vite: '^8.2.1' } })
    file('vite.config.ts', '')

    expect(detect(root).apps[0]?.plugin).toBe('absent')
  })

  it('counts a declared key with an empty range as declared', () => {
    // Weaker than the version read on purpose. A key with a broken value is still someone
    // having declared the dependency, and telling them to install what their own manifest
    // names is the wrong correction to make.
    manifest('package.json', { devDependencies: { '@dogear/vite': '' } })
    file('vite.config.ts', '')

    expect(detect(root).apps[0]?.plugin).toBe('dev')
  })

  it('reads each app’s own manifest, so one wired app does not cover for another', () => {
    manifest('package.json', { workspaces: ['packages/*'] })
    manifest('packages/wired/package.json', {
      devDependencies: { '@dogear/vite': '^1.0.0' },
    })
    manifest('packages/bare/package.json', {})
    file('packages/wired/vite.config.ts', '')
    file('packages/bare/vite.config.ts', '')

    const byDir = Object.fromEntries(
      detect(root).apps.map((app) => [app.dir, app.plugin]),
    )

    expect(byDir).toEqual({ 'packages/wired': 'dev', 'packages/bare': 'absent' })
  })
})

describe('detect() and which package owns an app', () => {
  it('names the app’s own directory when it has a manifest', () => {
    manifest('package.json', {})
    manifest('apps/web/package.json', {})
    file('apps/web/vite.config.ts', '')

    expect(detect(root).apps[0]?.manifestDir).toBe('apps/web')
  })

  it('names the directory one level up when the app has none of its own', () => {
    // The install command has to point here, not at the app: an install in `apps/web/client`
    // would grow a stray package.json in a directory that deliberately had none.
    manifest('package.json', {})
    manifest('apps/web/package.json', { dependencies: { react: '^19.2.0' } })
    file('apps/web/client/vite.config.ts', '')

    const nested = detect(root).apps.find((app) => app.dir === 'apps/web/client')

    expect(nested?.manifestDir).toBe('apps/web')
    // Same file the framework came from — the two answers cannot disagree about the package.
    expect(nested?.framework).toBe('react')
  })

  it('names the root as an empty string, not as a dot', () => {
    manifest('package.json', {})
    file('vite.config.ts', '')

    expect(detect(root).apps[0]?.manifestDir).toBe('')
  })

  it('is undefined when the repository has no manifest at all', () => {
    file('vite.config.ts', '')

    expect(detect(root).apps[0]?.manifestDir).toBeUndefined()
  })
})

describe('detect() and the framework list', () => {
  it.each([
    ['react', 'react', '^19.2.0'],
    ['vue', 'vue', '^3.5.0'],
    ['svelte', 'svelte', '^5.0.0'],
    ['solid', 'solid-js', '^1.9.0'],
    ['preact', 'preact', '^10.24.0'],
  ])('reports %s from its package %s', (framework, pkg, version) => {
    manifest('package.json', { dependencies: { [pkg]: version } })
    file('vite.config.ts', '')

    expect(detect(root).apps[0]).toMatchObject({ framework, frameworkVersion: version })
  })

  it('calls a preact/compat app preact, not react', () => {
    // The one ordering in FRAMEWORK_PACKAGES that is load-bearing: an aliased Preact app
    // declares `react` too, so a react-first scan reports every one of them as React. The
    // reverse mistake does not exist — a React app has no reason to depend on preact.
    manifest('package.json', {
      dependencies: { preact: '^10.24.0', react: '^19.2.0' },
    })
    file('vite.config.ts', '')

    expect(detect(root).apps[0]?.framework).toBe('preact')
  })

  it('prefers a runtime dependency over a dev one, as npm resolves it', () => {
    manifest('package.json', {
      dependencies: { react: '^19.2.0' },
      devDependencies: { react: '^18.0.0' },
    })
    file('vite.config.ts', '')

    expect(detect(root).apps[0]?.frameworkVersion).toBe('^19.2.0')
  })
})

describe('detect() on a workspace', () => {
  beforeEach(() => {
    manifest('package.json', {
      workspaces: ['packages/*', 'examples/*'],
      devDependencies: { vite: '^8.2.1' },
    })
    manifest('packages/ui/package.json', { dependencies: { react: '^19.2.0' } })
    manifest('packages/tokens/package.json', {})
    manifest('examples/web/package.json', {
      dependencies: { react: '^19.2.0' },
      devDependencies: { vite: '^8.2.1' },
    })
    file('examples/web/vite.config.ts', '')
  })

  it('names the layout and counts the packages the globs resolved to', () => {
    const { workspace, packages } = detect(root)

    expect(workspace).toBe('npm')
    expect(packages).toBe(3)
  })

  it('finds the app in the workspace member, with a repo-relative path', () => {
    expect(detect(root).apps).toEqual([
      {
        dir: 'examples/web',
        config: 'examples/web/vite.config.ts',
        framework: 'react',
        frameworkVersion: '^19.2.0',
        viteVersion: '^8.2.1',
        manifestDir: 'examples/web',
        plugin: 'absent',
      },
    ])
  })

  it('reads each app framework from its OWN manifest, not the root', () => {
    // Two apps in one repo routinely use different frameworks, and the note about the
    // JSX-only transform is wrong for the whole repo if this reads the root manifest.
    manifest('packages/admin/package.json', { dependencies: { vue: '^3.5.0' } })
    file('packages/admin/vite.config.ts', '')

    const frameworks = detect(root).apps.map(
      (app) => `${app.dir}:${String(app.framework)}`,
    )

    expect(frameworks).toContain('packages/admin:vue')
    expect(frameworks).toContain('examples/web:react')
  })

  it('looks only where the globs point, not everywhere below the root', () => {
    // The guided path replaces the walk rather than supplementing it. A config outside every
    // workspace pattern is not a workspace app, and reporting it as one would make the package
    // count and the app list describe two different repositories.
    file('scratchpad/vite.config.ts', '')

    expect(detect(root).apps.map((app) => app.dir)).toEqual(['examples/web'])
  })

  it('says yarn when a yarn.lock sits beside the same workspaces field', () => {
    file('yarn.lock', '')

    expect(detect(root).workspace).toBe('yarn')
  })

  it('honours a negated pattern', () => {
    manifest('package.json', { workspaces: ['packages/*', '!packages/tokens'] })

    expect(detect(root).packages).toBe(1)
  })

  it('accepts yarn’s object form of the field', () => {
    manifest('package.json', { workspaces: { packages: ['packages/*'] } })

    expect(detect(root).workspace).toBe('npm')
    expect(detect(root).packages).toBe(2)
  })

  it('counts only directories that actually hold a package.json', () => {
    mkdirSync(join(root, 'packages', 'scratch'), { recursive: true })

    expect(detect(root).packages).toBe(3)
  })
})

describe('detect() on a pnpm workspace', () => {
  beforeEach(() => {
    manifest('package.json', {})
    file('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n")
    manifest('apps/web/package.json', { dependencies: { vue: '^3.5.0' } })
    file('apps/web/vite.config.ts', '')
  })

  it('names the layout without a package count', () => {
    // The count is genuinely unknown: the globs live in YAML, and parsing that means either a
    // dependency the CLI does not have or a parser that will meet YAML it cannot read. The
    // report omits the number rather than guessing one.
    const { workspace, packages } = detect(root)

    expect(workspace).toBe('pnpm')
    expect(packages).toBeUndefined()
  })

  it('still finds the apps, because the walk covers what the globs would have', () => {
    expect(detect(root).apps.map((app) => app.dir)).toEqual(['apps/web'])
  })

  it('wins over a leftover workspaces array in the root manifest', () => {
    // Inert under pnpm. Reading it would report a package count pnpm is not using.
    manifest('package.json', { workspaces: ['packages/*'] })

    expect(detect(root).workspace).toBe('pnpm')
  })
})

describe('detect() and the places it must not look', () => {
  beforeEach(() => {
    manifest('package.json', {})
  })

  it('ignores a vite config inside node_modules', () => {
    // Virtually every dependency tree has one in some package's fixtures. Finding it would
    // report an app in a directory the user does not own and cannot annotate.
    file('node_modules/some-lib/vite.config.ts', '')

    expect(detect(root).apps).toEqual([])
  })

  it.each([['dist'], ['build'], ['out'], ['coverage'], ['.next']])(
    'ignores a vite config inside %s',
    (dir) => {
      file(`${dir}/vite.config.ts`, '')

      expect(detect(root).apps).toEqual([])
    },
  )

  it('stops at three levels down, and this pins the cap rather than hiding it', () => {
    // Documented, not aspirational: `a/b/c` is found and `a/b/c/d` is not. A layout deep
    // enough to escape this is nearly always a workspace, where the globs are read instead.
    file('a/b/c/vite.config.ts', '')
    file('a/b/c/d/vite.config.ts', '')

    expect(detect(root).apps.map((app) => app.dir)).toEqual(['a/b/c'])
  })
})

describe('detect() when the repository is broken', () => {
  it('returns rather than throwing on a package.json that will not parse', () => {
    // The rule that matters most in this file. Detection runs before every step, so a manifest
    // with a trailing comma four directories down would otherwise take out an init that had
    // nothing to do with it — and `dogear init` is how someone fixes a repo, not a reward for
    // having already fixed it.
    file('package.json', '{ "workspaces": [')
    file('vite.config.ts', '')

    expect(() => detect(root)).not.toThrow()
    expect(detect(root).apps.map((app) => app.dir)).toEqual([''])
  })

  it('survives a manifest that is valid JSON but not an object', () => {
    file('package.json', '"nope"')
    file('vite.config.ts', '')

    expect(detect(root).apps[0]?.framework).toBeUndefined()
  })

  it('survives a workspaces field of the wrong type', () => {
    file('package.json', JSON.stringify({ workspaces: 'packages/*' }))

    expect(detect(root).workspace).toBe('single')
  })

  it('survives a repository with no package.json at all', () => {
    file('vite.config.ts', '')

    const { workspace, apps } = detect(root)

    expect(workspace).toBe('single')
    expect(apps.map((app) => app.dir)).toEqual([''])
  })

  it('survives a directory named vite.config.ts', () => {
    // `existsSync` would call this an app. The state that matters is a readable *file*, which
    // is the same trap ./queue-dir.ts documents from the other direction.
    mkdirSync(join(root, 'vite.config.ts'))

    expect(detect(root).apps).toEqual([])
  })
})
