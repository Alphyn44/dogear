import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SENTINEL } from '../packages/core/src/sentinel.js'
import type { Packed, PublishedDir } from './fixture.js'
import {
  PUBLISHED,
  REPO_ROOT,
  builtFiles,
  createScratchProject,
  discard,
  manifestOf,
  npmName,
  packAll,
  runInstalledCli,
  startDevServer,
} from './fixture.js'

/**
 * H1 (#53) — what npm publishes, proven by installing it.
 *
 * Everything else in this repository resolves `dogear-core`, `dogear-vite` and `dogear-cli`
 * through workspace symlinks into `packages/*`, where `dist/` already exists because
 * `npm run build` put it there. `files`, `exports` and `bin` are therefore never consulted:
 * delete `"dist"` from any `files` array and all nine steps of `npm run verify` stay green,
 * while every consumer gets a tarball that installs cleanly, resolves cleanly and imports to
 * nothing.
 *
 * So this suite stops resolving through symlinks. It packs the real tarballs, installs them
 * into a project outside the workspace, and runs the three things a user runs: the binary,
 * `dogear init`, and a dev server with the plugin loaded.
 *
 * Runs under vitest.packed.config.ts, which needs `npm run build` first and is deliberately
 * not part of `npm run verify` — see that file.
 */

let packed: ReadonlyMap<string, Packed>
let tarballDir: string
let scratch: string

beforeAll(async () => {
  tarballDir = mkdtempSync(join(tmpdir(), 'dogear-tarballs-'))
  packed = await packAll(tarballDir)
  scratch = await createScratchProject(packed)
})

afterAll(() => {
  if (scratch !== undefined) discard(scratch)
  if (tarballDir !== undefined) discard(tarballDir)
})

/**
 * The entrypoints release.yml refuses to publish when they are missing or empty.
 *
 * That guard and this list fail on different things: it checks the *build* produced them,
 * this checks the *tarball* contains them. Neither is sufficient — see below.
 */
const ENTRYPOINTS: Readonly<Record<PublishedDir, readonly string[]>> = {
  core: ['dist/index.js', 'dist/noop.js', 'dist/client.js', 'dist/index.d.ts'],
  vite: ['dist/index.js', 'dist/index.d.ts'],
  cli: ['dist/cli.js'],
}

describe.each(PUBLISHED)('the dogear-%s tarball', (dir) => {
  const entry = (): Packed => {
    const found = packed.get(npmName(dir))
    if (found === undefined)
      throw new Error(`npm pack produced nothing for ${npmName(dir)}`)
    return found
  }

  it('contains every file the build produced', () => {
    // The assertion that actually catches a lost `files` entry, and it has to be this one
    // rather than the named list below.
    //
    // npm ALWAYS includes package.json, README, LICENSE, the file named in `main` and the
    // file(s) named in `bin`, whatever `files` says. dogear-cli names dist/cli.js in `bin`,
    // so deleting "dist" from its `files` array produces a tarball that still contains
    // dist/cli.js — and none of the `chunk-<hash>.js` files that cli.js imports on its first
    // line. Every named-entrypoint check passes; the binary exits 1 on `Cannot find module`.
    // Found by running it, not by reading npm's documentation.
    const shipped = new Set(entry().files)
    const missing = builtFiles(dir).filter((path) => !shipped.has(path))

    expect(
      missing,
      `dogear-${dir}'s tarball is missing ${String(missing.length)} file(s) the build ` +
        `produced: ${missing.join(', ')}. Check its \`files\` array and .npmignore.`,
    ).toEqual([])
  })

  it('contains the entrypoints a consumer imports', () => {
    // Kept alongside the comparison above even though it cannot fail on its own once that
    // one passes. It is the part that says what these packages are FOR — a build that
    // silently stopped emitting noop.js would satisfy "everything dist holds is shipped"
    // while shipping the wrong thing. scripts/packaging.test.ts covers the manifest side.
    for (const path of ENTRYPOINTS[dir]) {
      expect(
        entry().files,
        `dogear-${dir}'s tarball is missing ${path} — it would install and import to nothing.`,
      ).toContain(path)
    }
  })

  it('ships its manifest, README and licence', () => {
    // npm includes these whatever `files` says, so this is a check on the package directory
    // rather than on the allow-list: a package with no README of its own gets a blank npm
    // page, and one with no LICENSE declares MIT and contains no licence text.
    expect(entry().files).toContain('package.json')
    expect(entry().files).toContain('README.md')
    expect(entry().files).toContain('LICENSE')
  })

  it('carries no tests or fixtures', () => {
    const strays = entry().files.filter(
      (path) =>
        path.includes('.test.') || path.startsWith('src/') || path.startsWith('test-'),
    )

    expect(strays, `dogear-${dir} would publish ${strays.join(', ')}`).toEqual([])
  })
})

describe('the installed tree', () => {
  it('resolves dogear-core to the tarball, not to the registry', () => {
    // This enforces G2's decision rather than second-guessing it. The brief chose a caret
    // range over a pin *because* the two packages version independently, and recorded the
    // consequence: `^0.1.0` is `>=0.1.0 <0.2.0` under 0.x semver, so core ships patches on its
    // own while "a 0.2.0 that changes what the plugin serves at <endpoint>/client.js forces a
    // plugin release, which is the coupling that genuinely exists".
    //
    // The failure worth catching is not the range being tight — it is the moment that coupling
    // goes unhonoured. Bump core's minor and leave the plugin alone, and npm cannot satisfy
    // the range from the tarball, so it quietly installs a NESTED copy from the registry. The
    // install succeeds, the dev server starts, and the served bundle still carries the
    // sentinel — the old core has one too — so every other assertion in this file passes while
    // a real `npm i -D dogear-vite` pairs the new plugin with the old overlay. Until now that
    // rule lived only in the Decisions log; this is what makes it fail out loud.
    expect(
      existsSync(
        join(scratch, 'node_modules', 'dogear-vite', 'node_modules', 'dogear-core'),
      ),
      "dogear-vite's dogear-core range does not admit the core version in this tree, so npm " +
        'installed a second copy from the registry underneath the plugin. A core minor bump ' +
        "forces a plugin release: widen dogear-vite's range and bump it. See G2 in the " +
        "brief's Decisions log.",
    ).toBe(false)

    // Resolved the way packages/vite/src/client.ts does it — from the installed plugin, by
    // manifest rather than by package name — so a nested copy would be found here even if the
    // check above ever stopped seeing it.
    const fromPlugin = createRequire(
      join(scratch, 'node_modules', 'dogear-vite', 'dist', 'index.js'),
    )
    const manifestPath = fromPlugin.resolve('dogear-core/package.json')
    const resolved = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }

    expect(resolved.version).toBe(manifestOf('core').version)
  })

  it('puts `dogear` on PATH, not `dogear-cli`', () => {
    // npm writes a symlink on POSIX and a .cmd shim on Windows. The name is what every
    // README, every init instruction and the brief all say to type.
    const bin = join(scratch, 'node_modules', '.bin')
    const shim = process.platform === 'win32' ? 'dogear.cmd' : 'dogear'

    expect(existsSync(join(bin, shim))).toBe(true)
  })
})

describe('the installed binary', () => {
  it('runs from the path everything `dogear init` writes points at', async () => {
    // node_modules/dogear-cli/dist/cli.js is not an arbitrary way to spawn it: it is the exact
    // string the MCP registration and Claude Code's prompt hook are given, repo-relative and
    // committed. If it does not resolve after an install, the failure surfaces as an MCP
    // server that exits 1 on spawn and a hook that fails on every prompt the user types.
    const help = await runInstalledCli(scratch, ['--help'])

    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('init')
  })

  it('initializes the project, and writes a CLI path that resolves', async () => {
    const run = await runInstalledCli(scratch, ['init'])

    expect(run.exitCode).toBe(0)
    expect(existsSync(join(scratch, '.dogear'))).toBe(true)

    const registered = JSON.parse(readFileSync(join(scratch, '.mcp.json'), 'utf8')) as {
      mcpServers: { dogear: { command: string; args: readonly string[] } }
    }

    expect(registered.mcpServers.dogear.command).toBe('node')

    const written = registered.mcpServers.dogear.args[0]
    expect(written).toBe('node_modules/dogear-cli/dist/cli.js')
    // The whole point of the path being repo-relative and committed: it has to resolve for
    // whoever clones, from the repository root. H6 (#58) is the same assertion under pnpm and
    // Yarn; this is the npm leg of it.
    expect(existsSync(join(scratch, written ?? ''))).toBe(true)
  })
})

describe('the installed plugin', () => {
  it("serves dogear-core's real bundle, not the unbuilt stub", async () => {
    // The criterion a wrong `exports` map breaks, and the one nothing else can see. A plugin
    // that fails to resolve core still starts a server, still serves the page, and still
    // injects a script — it just hands the browser a console.warn. Asserting "an annotation
    // endpoint answered" would pass on that build.
    const server = await startDevServer(scratch)

    try {
      const html = await (await fetch(`${server.origin}/`)).text()

      const tag = /<script[^>]*data-dogear[^>]*>/.exec(html)?.[0]
      expect(tag, `no dogear script tag was injected into:\n${html}`).toBeDefined()

      const src = tag === undefined ? undefined : /src="([^"]+)"/.exec(tag)?.[1]
      expect(src, `the injected tag carries no src: ${String(tag)}`).toBeDefined()

      const bundle = await fetch(new URL(src ?? '', server.origin))
      expect(bundle.ok).toBe(true)

      const body = await bundle.text()

      // SENTINEL lives only in core's real dist/client.js — index.js deliberately cannot
      // carry it, and noop.js is the inert build. Reaching it here means the installed plugin
      // resolved the installed core through its exports map and read the right file out of
      // the right dist/.
      expect(body).toContain(SENTINEL)
      // MISSING_BUNDLE_STUB in packages/vite/src/client-route.ts, which is what a failed
      // resolution serves instead. Asserted separately from the line above so the failure
      // message says which of the two happened.
      expect(body).not.toContain('has not been built')
    } finally {
      // Awaited: afterAll removes the tree this server has modules open in.
      await server.stop()
    }
  })
})

describe('the suite itself', () => {
  it('runs against a project outside this workspace', () => {
    // `findGitRoot` walks up for `.git`. A scratch project inside the repository would resolve
    // to the repository, so `dogear init` would write into the real .dogear/ and the plugin
    // would serve this repo's queue — every case above would pass while proving nothing about
    // an install. Cheap to assert, and invisible if it ever stops being true.
    expect(scratch.startsWith(REPO_ROOT)).toBe(false)
  })
})
