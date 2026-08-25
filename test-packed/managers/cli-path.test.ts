import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Linker, Manager, Packed } from '../fixture.js'
import {
  createScratchProject,
  discard,
  manifestOf,
  packAll,
  runInstalledCli,
  runManager,
} from '../fixture.js'

/**
 * H6 (#58) — the committed CLI path, under something other than npm.
 *
 * Everything `dogear init` writes names `node_modules/dogear-cli/dist/cli.js`: the MCP
 * registration in `.mcp.json`, and Claude Code's `UserPromptSubmit` hook in
 * `.claude/settings.json`. The path is repo-relative and **committed** on purpose — an absolute
 * path to a global install would be broken for every other machine the moment it landed — which
 * means it has to resolve for whoever clones, with whatever tool they install with.
 *
 * That npm, pnpm and Yarn's `node-modules` linker all place a **direct** dependency at the top
 * level of `node_modules` is true, and until this file it was *reasoning*: README.md states it
 * as fact and nothing ran it. H1's suite covers the npm leg; these are the other three.
 *
 * **The PnP leg asserts the opposite, and that is the story rather than an afterthought.** The
 * acceptance criterion is that Yarn PnP is "either supported or documented as unsupported, on
 * the strength of a test rather than reasoning" — so the test that makes the README's exception
 * true is one that watches the path fail to resolve.
 *
 * **No dev server here.** H1's npm leg already drives one and asserts the plugin resolves core's
 * real bundle; what varies between managers is the shape of `node_modules`, and that is settled
 * long before Vite starts. Adding a server per leg would triple the slowest thing in the
 * repository to re-prove something that does not vary.
 *
 * Runs under vitest.managers.config.ts, which needs `npm run build` first and the `pnpm` and
 * `@yarnpkg/cli-dist` devDependencies.
 */

/** The path every config init writes points at, as a repo-relative POSIX string. */
const CLI_ENTRY = 'node_modules/dogear-cli/dist/cli.js'

interface Leg {
  /** What the case is called, and the scratch directory's suffix. */
  readonly name: string
  readonly manager: Manager
  readonly linker: Linker
}

/**
 * The three legs, npm's being H1's.
 *
 * Yarn appears twice because its linker is a *setting*, not a property of the tool: the same
 * binary produces a supported layout and an unsupported one depending on one line of
 * `.yarnrc.yml`. Berry covers both, which is why there is no Yarn 1 leg — classic has no PnP
 * mode to test, and its node-modules layout is the one the leg below already asserts.
 */
const NODE_MODULES_LEGS: readonly Leg[] = [
  { name: 'pnpm', manager: 'pnpm', linker: 'node-modules' },
  { name: 'yarn (node-modules linker)', manager: 'yarn', linker: 'node-modules' },
]

let packed: ReadonlyMap<string, Packed>
let tarballDir: string

beforeAll(async () => {
  tarballDir = mkdtempSync(join(tmpdir(), 'dogear-tarballs-'))
  packed = await packAll(tarballDir)
}, 600_000)

afterAll(() => {
  if (tarballDir !== undefined) discard(tarballDir)
})

describe.each(NODE_MODULES_LEGS)('installed with $name', ({ manager, linker }) => {
  let scratch: string

  beforeAll(async () => {
    scratch = await createScratchProject(packed, { manager, linker })
    const run = await runInstalledCli(scratch, ['init'])

    // Init failing is a different bug from the path not resolving, and a leg that swallowed it
    // would report the second when it had found the first.
    expect(
      run.exitCode,
      `dogear init failed under ${manager}:\n${run.stdout}\n${run.stderr}`,
    ).toBe(0)
  }, 900_000)

  afterAll(() => {
    if (scratch !== undefined) discard(scratch)
  })

  it('writes a CLI path that exists', () => {
    const registered = JSON.parse(readFileSync(join(scratch, '.mcp.json'), 'utf8')) as {
      mcpServers: { dogear: { command: string; args: readonly string[] } }
    }

    // `node <path>`, never `dogear` — a global npm bin on Windows is a .cmd shim the exec form
    // cannot run.
    expect(registered.mcpServers.dogear.command).toBe('node')
    expect(registered.mcpServers.dogear.args[0]).toBe(CLI_ENTRY)
    expect(existsSync(join(scratch, CLI_ENTRY))).toBe(true)
  })

  it('writes a CLI path that RUNS', async () => {
    // Existence is not the criterion. `dogear-cli` is code-split — cli.js imports a
    // `chunk-<hash>.js` on its first line — so a tarball that shipped the entry and not its
    // chunks satisfies the assertion above and exits 1 on `Cannot find module`. Spawning it the
    // way the MCP registration spawns it is what closes that gap.
    const help = await runInstalledCli(scratch, ['--help'])

    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('init')
  })

  it('points the prompt hook at the same path', () => {
    // The worse failure of the two, and the reason both surfaces are asserted. An MCP server
    // that will not start is silent until a tool is called; a hook pointing at a missing file
    // fails on every prompt the user types.
    const settings = readFileSync(join(scratch, '.claude', 'settings.json'), 'utf8')

    // `${CLAUDE_PROJECT_DIR}/` rather than bare, because a hook's working directory is the
    // session's and not the repository's.
    expect(settings).toContain(`\${CLAUDE_PROJECT_DIR}/${CLI_ENTRY}`)
  })

  it('puts `dogear` on PATH', () => {
    const bin = join(scratch, 'node_modules', '.bin')
    const shim = process.platform === 'win32' ? 'dogear.cmd' : 'dogear'

    expect(existsSync(join(bin, shim))).toBe(true)
  })

  it('resolves dogear-core to the tarball, not to the registry', () => {
    // Asserted by RESOLUTION rather than by the absence of
    // `node_modules/dogear-vite/node_modules/dogear-core`, which is how H1's npm leg spells it.
    // That path check reads npm's hoisted tree; under pnpm `node_modules/dogear-vite` is a
    // symlink into `.pnpm/`, so the nested path is absent whatever happened and the assertion
    // would pass without testing anything. Resolving the way packages/vite/src/client.ts does
    // — from the installed plugin, by manifest rather than by package name — is the form that
    // means the same thing under every layout.
    const fromPlugin = createRequire(
      join(scratch, 'node_modules', 'dogear-vite', 'dist', 'index.js'),
    )
    const resolved = JSON.parse(
      readFileSync(fromPlugin.resolve('dogear-core/package.json'), 'utf8'),
    ) as { version: string }

    expect(resolved.version).toBe(manifestOf('core').version)
  })
})

describe('installed with yarn (PnP linker)', () => {
  let scratch: string
  let report: string

  beforeAll(async () => {
    scratch = await createScratchProject(packed, { manager: 'yarn', linker: 'pnp' })

    // Through Yarn's own runtime, because that is the only way to run anything in a PnP
    // project: there is no node_modules for `node <path>` to find, which is the whole finding.
    const run = await runManager('yarn', ['dogear', 'init'], scratch)
    report = `${run.stdout}\n${run.stderr}`
  }, 900_000)

  afterAll(() => {
    if (scratch !== undefined) discard(scratch)
  })

  it('creates no node_modules for the committed path to resolve in', () => {
    // The README's documented exception, as a result rather than an argument. If this ever goes
    // green because Yarn grew a compatibility shim, the exception should be deleted and the
    // node-modules legs above gain a third entry.
    expect(existsSync(join(scratch, CLI_ENTRY))).toBe(false)
  })

  it('cannot run the CLI the way every config init writes spawns it', async () => {
    // The consequence stated end to end: this is precisely what an MCP client does on spawn,
    // and what Claude Code's prompt hook does on every prompt the user types.
    const help = await runInstalledCli(scratch, ['--help'])

    expect(help.exitCode).not.toBe(0)
  })

  it('installed dogear-cli perfectly well, which is what makes it a trap', async () => {
    // Not a failed install. The package is there and Yarn will run it — through its own
    // runtime, by name. What does not survive is the *committed path*, and the difference
    // between those two facts is the entire reason init has to say something.
    const run = await runManager('yarn', ['dogear', '--help'], scratch)

    expect(run.stdout).toContain('init')
  })

  it('warns rather than writing the path silently', () => {
    // The other half of H6, and the reason detect.ts gained `Detection.linker`. `cliIn` answers
    // `local` from the manifest declaration when the file is absent — right for a repository
    // mid-clone, wrong for one that will never have the file — so before this ticket init wrote
    // the registration above and said nothing at all. Revert that change and this case is the
    // one that goes red.
    expect(report).toContain("Yarn's PnP linker")
    expect(report).toContain(CLI_ENTRY)
  })

  it('does not tell the user to install what they have already installed', () => {
    // The PnP arm is checked before `wiring.cli` in scaffold.ts's remark, and this is what that
    // ordering buys: `yarn add -D dogear-cli` is advice this repository has already followed.
    expect(report).not.toContain('add -D dogear-cli')
  })
})
