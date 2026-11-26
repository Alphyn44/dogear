import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { QUEUE_DIR } from 'dogear-queue'
import { describe, expect, it, vi } from 'vitest'

import type { GitQueries } from './git.js'
import { scaffold } from './scaffold.js'
import { root, useScaffoldRepo, WIRED_CONFIG } from './test-scaffold.js'

/**
 * What `dogear init` says about the repository it found. Split out of ./scaffold.test.ts by
 * #87.
 *
 * Detection's findings (E2, #27), the install guidance that ends every report (E8, #41), and a
 * Next.js app in place of a Vite one (J5, #81). ./scaffold.test.ts keeps the runner itself, and
 * ./test-scaffold.ts holds the fixture all three suites share.
 *
 * **git is not asked here** (#87). Nothing in this file writes an ignore rule or stages a
 * file, so real git would answer "not ignored, not tracked" to every question, and the stub
 * below gives that answer without a process. The reports are byte-identical either way. The
 * cases whose output depends on git's answers are ./scaffold.test.ts's, which still ask it, and
 * ./git.test.ts and ./gitignore.test.ts own the answers themselves. A case added here that
 * sets up a rule or a tracked file belongs in ./scaffold.test.ts instead.
 */

vi.mock('./git.js', (): { git: GitQueries } => ({
  git: { ignored: () => new Set(), isTracked: () => false },
}))

useScaffoldRepo()

describe('scaffold() reporting what it detected', () => {
  it('says so plainly when there is no vite config, and still sets the repo up', () => {
    // Reported, not refused. Detection is a guess, and a guess that blocked init would turn a
    // repository with an unusual config filename into one dogear cannot be installed in.
    // Everything init writes is inert without Vite, and E3's MCP wiring is not.
    rmSync(join(root, 'vite.config.ts'))

    const result = scaffold(root)

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('app:       none found')
    expect(result.output).toContain('note: no vite.config or next.config found')
    expect(existsSync(join(root, QUEUE_DIR))).toBe(true)
  })

  it('still gives a verdict on a re-run of a repo with no vite config', () => {
    // Detection's remarks do not suppress `nothing changed`, unlike a step's notes. Without
    // that split, the commonest reason to run init twice is also the case where it never says
    // whether it did anything — which ../test-built/init.test.ts caught first.
    rmSync(join(root, 'vite.config.ts'))
    scaffold(root)

    const again = scaffold(root)

    expect(again.output).toContain('nothing changed')
    expect(again.output).toContain('note: no vite.config or next.config found')
  })

  it('names each app in a monorepo, because their frameworks differ', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'], devDependencies: { vite: '^8.2.1' } }),
    )
    rmSync(join(root, 'vite.config.ts'))
    for (const [name, dep] of [
      ['web', { react: '^19.2.0' }],
      ['admin', { vue: '^3.5.0' }],
    ] as const) {
      mkdirSync(join(root, 'packages', name), { recursive: true })
      writeFileSync(
        join(root, 'packages', name, 'package.json'),
        JSON.stringify({ dependencies: dep }),
      )
      writeFileSync(join(root, 'packages', name, 'vite.config.ts'), '')
    }

    const output = scaffold(root).output

    expect(output).toContain('apps:      packages/admin — vue ^3.5.0 (vite.config.ts)')
    expect(output).toContain('           packages/web — react ^19.2.0 (vite.config.ts)')
    expect(output).toContain('workspace: npm workspaces, 2 packages, 2 apps')
  })

  it('warns that a non-JSX app gets the selector floor, and only about that app', () => {
    // brief:1517 — the transform is JSX-only, so a Vue app's annotations carry no exact source
    // location. Saying nothing would leave the user to discover that by using it.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.5.0' } }),
    )

    const output = scaffold(root).output

    expect(output).toContain('note: . (vue) — ')
    expect(output).toContain('JSX-only')
  })

  it('says nothing about the transform for a React app', () => {
    expect(scaffold(root).output).not.toContain('JSX-only')
  })
})

describe('scaffold() telling the user to install the plugin', () => {
  /** The fixture above has a vite config and no `dogear-vite`, so the block is expected. */
  const HEADING = 'add dogear to vite.config.ts:'

  it('prints the snippet and the install command below the report', () => {
    const lines = scaffold(root).output.split('\n')
    const at = lines.indexOf(HEADING)

    expect(at).toBeGreaterThan(0)
    expect(lines.indexOf('  created .gitignore')).toBeLessThan(at)
  })

  it('separates the block from the report with a blank line', () => {
    const lines = scaffold(root).output.split('\n')

    expect(lines[lines.indexOf(HEADING) - 1]).toBe('')
  })

  it('leaves the block OUTSIDE the report’s indent', () => {
    // Not cosmetic. The two-space indent belongs to the one-line-per-item body, and the snippet
    // carries an indent of its own that the body's would corrupt — this is text the user copies
    // into a config file, so the leading whitespace is content.
    const output = scaffold(root).output

    expect(output).toContain("\n  import { dogear } from 'dogear-vite'")
    expect(output).not.toContain("\n    import { dogear } from 'dogear-vite'")
  })

  it('writes nothing to say it — the manifest is untouched', () => {
    // E8's whole decision. init prints the dependency rather than adding it: no range resolves
    // while the packages are unpublished, and a manifest edited without a lockfile update fails
    // the next `npm ci`.
    const before = readFileSync(join(root, 'package.json'), 'utf8')

    scaffold(root)

    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  })

  it('says nothing once the plugin is declared AND the config calls it', () => {
    // Both halves, because G3 (#44) made them independent — the fixture's `vite.config.ts` is
    // empty, and a declaration alone leaves an app whose overlay never loads.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.2.1', 'dogear-vite': '^1.0.0' } }),
    )
    writeFileSync(join(root, 'vite.config.ts'), WIRED_CONFIG)

    expect(scaffold(root).output).not.toContain('add dogear to')
  })

  it('still asks for the config edit when only the package is there', () => {
    // The state the install path actually produces: `npm i -D dogear-vite` and nothing else.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.2.1', 'dogear-vite': '^1.0.0' } }),
    )

    const output = scaffold(root).output

    expect(output).toContain('add dogear to vite.config.ts:')
    // And does not tell them to install what they just installed.
    expect(output).not.toContain('npm i -D dogear-vite')
  })

  it('reports a runtime dependency as the leak it is, and does not move it', () => {
    // The manifest half of what scripts/check-leak.ts catches: a dev-only plugin in
    // `dependencies` installs in production even when every bundle is clean.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { 'dogear-vite': '^1.0.0' } }),
    )
    writeFileSync(join(root, 'vite.config.ts'), WIRED_CONFIG)

    const output = scaffold(root).output

    expect(output).toContain('note: dogear-vite is a runtime dependency')
    expect(output).toContain('devDependencies')
    // Declared is declared — the import resolves, so it is not also told to install it.
    expect(output).not.toContain('add dogear to')
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({
      dependencies: { 'dogear-vite': '^1.0.0' },
    })
  })

  it('withholds the block when a step failed', () => {
    // Telling someone to install a plugin into a repository init could not finish setting up
    // buries the thing they actually need to act on. The re-run prints it.
    writeFileSync(join(root, QUEUE_DIR), 'not a directory')

    const result = scaffold(root)

    expect(result.exitCode).toBe(1)
    expect(result.output).not.toContain('add dogear to')
  })

  it('says nothing at all when the repo has no vite config', () => {
    rmSync(join(root, 'vite.config.ts'))

    expect(scaffold(root).output).not.toContain('add dogear to')
  })
})

describe('scaffold() on a Next.js app — J5 (#81)', () => {
  /** Swap the fixture's Vite app for a Next one, App Router included. */
  function nextRepo(
    dependencies: Record<string, string> = {},
    devDependencies = {},
  ): void {
    rmSync(join(root, 'vite.config.ts'))
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^16.4.6', react: '^19.2.0', ...dependencies },
        devDependencies: { 'dogear-cli': '^0.1.0', ...devDependencies },
      }),
    )
    writeFileSync(join(root, 'next.config.ts'), '')
    mkdirSync(join(root, 'app'))
  }

  it('reports the Next app instead of "no vite config found"', () => {
    nextRepo()

    const output = scaffold(root).output

    expect(output).toContain('next:      next.config.ts (next ^16.4.6)')
    expect(output).toContain('framework: react ^19.2.0')
    expect(output).not.toContain('none found')
    expect(output).not.toContain('no vite.config or next.config found')
  })

  it('prints the withDogear wrapper and a runtime install, and writes neither', () => {
    nextRepo()
    const before = readFileSync(join(root, 'package.json'), 'utf8')

    const output = scaffold(root).output

    expect(output).toContain('add dogear to next.config.ts:')
    expect(output).toContain("\n  import { withDogear } from 'dogear-next'")
    expect(output).toContain('then, at the repo root: npm i dogear-next')
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(root, 'next.config.ts'), 'utf8')).toBe('')
  })

  it('names a Next app in a subdirectory with its own directory and manager', () => {
    // The layout #75 and J7 both name: no root package.json, the app in web/, and a lockfile
    // that only web/ has.
    rmSync(join(root, 'vite.config.ts'))
    rmSync(join(root, 'package.json'))
    mkdirSync(join(root, 'web', 'app'), { recursive: true })
    writeFileSync(
      join(root, 'web', 'package.json'),
      JSON.stringify({ dependencies: { next: '^16.4.6', react: '^19.2.0' } }),
    )
    writeFileSync(join(root, 'web', 'pnpm-lock.yaml'), '')
    writeFileSync(join(root, 'web', 'next.config.mjs'), '')

    const output = scaffold(root).output

    expect(output).toContain('next:      web/next.config.mjs (next ^16.4.6)')
    expect(output).toContain('add dogear to web/next.config.mjs:')
    expect(output).toContain('then, in web: pnpm add dogear-next')
  })

  it('gives a repository with a Vite app and a Next app guidance for each', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        workspaces: ['apps/*'],
        devDependencies: { 'dogear-cli': '^0.1.0' },
      }),
    )
    rmSync(join(root, 'vite.config.ts'))
    for (const [name, config, deps] of [
      ['admin', 'vite.config.ts', { devDependencies: { vite: '^8.2.1' } }],
      ['web', 'next.config.ts', { dependencies: { next: '^16.4.6' } }],
    ] as const) {
      mkdirSync(join(root, 'apps', name, 'app'), { recursive: true })
      writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify(deps))
      writeFileSync(join(root, 'apps', name, config), '')
    }

    const output = scaffold(root).output

    expect(output).toContain('add dogear to apps/admin/vite.config.ts:')
    expect(output).toContain('then, in apps/admin: npm i -D dogear-vite')
    expect(output).toContain('add dogear to apps/web/next.config.ts:')
    expect(output).toContain('then, in apps/web: npm i dogear-next')
  })

  it('reports dogear-next in devDependencies, and does not move it', () => {
    // `next start` loads next.config in production, so a production install without
    // devDependencies cannot load the import. The inverse of dogear-vite's leak note.
    nextRepo({}, { 'dogear-next': '^0.1.0' })
    const before = readFileSync(join(root, 'package.json'), 'utf8')

    const output = scaffold(root).output

    expect(output).toContain(
      'note: dogear-next is a dev dependency in the root package.json. next start loads',
    )
    expect(output).not.toContain('dogear-next is a runtime dependency')
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  })

  it('says nothing about dogear-next in dependencies, which is where it belongs', () => {
    nextRepo({ 'dogear-next': '^0.1.0' })

    const output = scaffold(root).output

    expect(output).not.toContain('dogear-next is a')
    expect(output).not.toContain('dogear-vite is a runtime dependency')
  })

  it('notes a Next app with no App Router directory', () => {
    nextRepo()
    rmSync(join(root, 'app'), { recursive: true })
    mkdirSync(join(root, 'pages'))

    expect(scaffold(root).output).toContain(
      'note: .: no app/ directory found. dogear supports the Next.js App Router only',
    )
  })

  it('does not note src/app/, which is an App Router too', () => {
    nextRepo()
    rmSync(join(root, 'app'), { recursive: true })
    mkdirSync(join(root, 'src', 'app'), { recursive: true })

    expect(scaffold(root).output).not.toContain('no app/ directory found')
  })
})
