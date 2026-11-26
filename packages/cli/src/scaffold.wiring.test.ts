import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { QUEUE_DIR } from 'dogear-queue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ALLOW } from './claude-settings.js'
import type { Agent, CliHome, Detection } from './detect.js'
import { CLI_ENTRY, cliEntry } from './detect.js'
import type { GitQueries } from './git.js'
import { resolveWiring, scaffold, unscaffold } from './scaffold.js'
import { NO_DETECTION } from './test-repo.js'
import { root, useScaffoldRepo } from './test-scaffold.js'

/**
 * How `dogear init` wires agents. Split out of ./scaffold.test.ts by #87.
 *
 * E3's (#28) reconciliation of the flags with detection and its three steps through the runner,
 * G3's (#44) local CLI path, and #75's repository whose only `package.json` is in a
 * subdirectory. ./scaffold.test.ts keeps the runner itself, and ./test-scaffold.ts holds the
 * fixture all three suites share.
 *
 * **git is not asked here** (#87), for the reason ./scaffold.report.test.ts gives: nothing in
 * this file writes an ignore rule or stages a file, so the stub's "not ignored, not tracked"
 * is what real git would say. A case that needs a different answer belongs in
 * ./scaffold.test.ts, which still asks it.
 */

vi.mock('./git.js', (): { git: GitQueries } => ({
  git: { ignored: () => new Set(), isTracked: () => false },
}))

useScaffoldRepo()

describe('resolveWiring() reconciling flags with detection — E3 (#28)', () => {
  const detection = (
    agents: readonly Agent[],
    cli: CliHome | undefined = NO_DETECTION.cli,
  ): Detection => ({
    ...NO_DETECTION,
    agents: agents.map((agent) => ({ agent, marker: `.${agent}/` })),
    cli,
  })

  /** Where #75's layout keeps the CLI: `web/`, the only package in the repository. */
  const WEB: CliHome = {
    dir: 'web',
    state: 'local',
    manager: 'npm',
    linker: 'node-modules',
    pnpmWorkspaceRoot: false,
  }

  it('uses what detection found when no flag was given', () => {
    expect(resolveWiring(detection(['cursor', 'vscode']), {}).agents).toEqual([
      'cursor',
      'vscode',
    ])
  })

  it('falls back to claude when detection found nothing', () => {
    // Not a guess about the user's tooling — `.mcp.json` at the root is the portable default,
    // and a baseline path that skipped the fresh-clone case would not be a baseline.
    expect(resolveWiring(detection([]), {}).agents).toEqual(['claude'])
  })

  it('replaces detection rather than adding to it', () => {
    // The reason the flag replaces: subtraction. A repo with a `.cursor/` the user does not
    // want touched has no other way to say so.
    expect(resolveWiring(detection(['cursor']), { agents: ['claude'] }).agents).toEqual([
      'claude',
    ])
  })

  it('honours an explicit empty selection, which is --agent=none', () => {
    // The case that makes `undefined` and `[]` different types of answer all the way down.
    expect(resolveWiring(detection(['claude']), { agents: [] }).agents).toEqual([])
  })

  it('defaults the hook on and lets --no-hook turn it off', () => {
    expect(resolveWiring(detection([]), {}).hook).toBe(true)
    expect(resolveWiring(detection([]), { hook: false }).hook).toBe(false)
  })

  it('names the root’s path when the CLI lives at the root', () => {
    expect(resolveWiring(detection([]), {}).entry).toBe(CLI_ENTRY)
  })

  it('names the web/ path when the CLI lives in web/ (#75)', () => {
    expect(resolveWiring(detection([], WEB), {}).entry).toBe(
      'web/node_modules/dogear-cli/dist/cli.js',
    )
  })

  it('withholds nothing when there is somewhere for the CLI to live', () => {
    expect(resolveWiring(detection(['cursor']), {}).withheld).toEqual([])
  })

  // Not `detection(agents, undefined)`: an explicit `undefined` takes the parameter's default,
  // which is a home at the root, and the first draft of these cases tested nothing but that.
  const nowhere = (agents: readonly Agent[]): Detection => ({
    ...detection(agents),
    cli: undefined,
  })

  it('wires nothing when the CLI has nowhere to live, and keeps what it held back (#75)', () => {
    const wiring = resolveWiring(nowhere([]), {})

    expect(wiring.agents).toEqual([])
    expect(wiring.withheld).toEqual(['claude'])
  })

  it('holds back an explicit --agent too, since no flag makes a path resolve', () => {
    const wiring = resolveWiring(nowhere([]), { agents: ['cursor'] })

    expect(wiring.agents).toEqual([])
    expect(wiring.withheld).toEqual(['cursor'])
  })

  it('holds back nothing under --agent=none, which asked for nothing', () => {
    expect(resolveWiring(nowhere(['claude']), { agents: [] }).withheld).toEqual([])
  })
})

describe('scaffold() wiring an agent — E3 (#28)', () => {
  it('registers the MCP server, which is the baseline and never skipped', () => {
    scaffold(root)

    expect(
      JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as unknown,
    ).toMatchObject({
      mcpServers: {
        dogear: {
          command: 'node',
          args: ['node_modules/dogear-cli/dist/cli.js', 'mcp'],
        },
      },
    })
  })

  it('leaves a fully working install when the hook is declined', () => {
    // #28's third criterion. MCP carries the whole feature set; the hook only removes the need
    // to ask for it, so declining must cost the asking and nothing else.
    const result = scaffold(root, { hook: false })

    expect(result.exitCode).toBe(0)
    expect(existsSync(join(root, '.mcp.json'))).toBe(true)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
    expect(result.output).not.toContain('prompt hook')

    // #76: the tool permissions are not part of the hook, so declining it keeps them.
    const settings = JSON.parse(
      readFileSync(join(root, '.claude', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(settings).toEqual({ permissions: { allow: [...ALLOW] } })
  })

  it('adds the tool permissions to a repository initialised before #76', () => {
    scaffold(root)
    const path = join(root, '.claude', 'settings.json')
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    delete legacy.permissions
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`)

    const line = "dogear's MCP tool permissions to .claude/settings.json"
    expect(scaffold(root, { dryRun: true }).output).toContain(`  would add ${line}`)
    expect(scaffold(root).output).toContain(`  added ${line}`)
    expect(scaffold(root).output).toContain('nothing changed')
  })

  it('wires only what --agent named', () => {
    scaffold(root, { agents: ['cursor'] })

    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true)
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    // No Claude Code among the agents, so no hook — without needing --no-hook as well.
    expect(existsSync(join(root, '.claude'))).toBe(false)
  })

  it('wires nothing at all for --agent=none, and still sets up .dogear/', () => {
    const result = scaffold(root, { agents: [] })

    expect(existsSync(join(root, QUEUE_DIR))).toBe(true)
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  /**
   * G3 (#44). E3 noted this from ./mcp-config.ts, gated on a registration being *written* — so
   * it fired once and never again, and a repository whose config was right but whose CLI was
   * missing re-ran init, read `nothing changed`, and had an MCP server that exited 1 on spawn
   * and a prompt hook that failed on every prompt. It is a remark now: it describes the
   * repository, so it prints every run and silences nothing.
   */
  describe('and the local CLI the configs point at', () => {
    /** The fixture declares `dogear-cli`; these cases are about a repository that does not. */
    function withoutCli(): void {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ devDependencies: { vite: '^8.2.1' } }),
      )
    }

    it('says so on the run that writes the registration', () => {
      withoutCli()

      expect(scaffold(root).output).toContain('npm i -D dogear-cli')
    })

    it('says so again on a re-run that changes nothing', () => {
      withoutCli()
      scaffold(root)

      const output = scaffold(root).output

      expect(output).toContain('npm i -D dogear-cli')
      // And still gives a verdict: a remark describes the repository, so unlike a step note it
      // does not eat the only line answering the question the user asked.
      expect(output).toContain('nothing changed')
    })

    it('names the prompt hook too, which has no warning of its own', () => {
      withoutCli()

      expect(scaffold(root).output).toContain(
        'the MCP registration and the prompt hook both point',
      )
    })

    it('names only the registration under --no-hook', () => {
      withoutCli()

      const output = scaffold(root, { hook: false }).output

      expect(output).toContain('the MCP registration points')
      expect(output).not.toContain('prompt hook')
    })

    it('says nothing when --agent=none wired nothing to point at it', () => {
      withoutCli()

      expect(scaffold(root, { agents: [] }).output).not.toContain('npm i -D dogear-cli')
    })

    it('says nothing once the CLI is installed', () => {
      expect(scaffold(root).output).not.toContain('npm i -D dogear-cli')
    })

    it.each([
      ['pnpm-lock.yaml', 'pnpm add -D dogear-cli'],
      ['yarn.lock', 'yarn add -D dogear-cli'],
    ])('names the manager the repo actually uses, given %s', (lockfile, command) => {
      // H6 (#58). This said `npm i -D` to every repository until then — including the pnpm and
      // yarn ones ./guidance.ts's own table already got right for the plugin install one line
      // below it, which is why the fix is an import rather than a second table.
      withoutCli()
      writeFileSync(join(root, lockfile), '')

      expect(scaffold(root).output).toContain(command)
    })

    it('adds -w at a pnpm workspace root, where pnpm 9 refuses the add without it (#85)', () => {
      // The single-package pnpm row above is the negative: no workspace file, no `-w`.
      withoutCli()
      writeFileSync(join(root, 'pnpm-lock.yaml'), '')
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")

      expect(scaffold(root).output).toContain(
        'which is not installed here. Run `pnpm add -D -w dogear-cli` so the path resolves',
      )
    })

    describe('under Yarn PnP — H6 (#58)', () => {
      /**
       * A repository that installs with PnP: the artefact at the root, and `dogear-cli`
       * genuinely declared.
       *
       * The declaration is the point. `cliIn` answers `local` from it when the file is absent,
       * which is right for a repo mid-clone and wrong for one that will never have the file —
       * so this is the shape that reached `state === 'local'` and returned silently.
       */
      function withPnp(): void {
        writeFileSync(join(root, '.pnp.cjs'), '')
      }

      it('warns even though the CLI is declared and `cli` reads local', () => {
        withPnp()

        const output = scaffold(root).output

        expect(output).toContain("Yarn's PnP linker")
        expect(output).toContain(CLI_ENTRY)
      })

      it('does not tell the user to install what they have already installed', () => {
        // The reason the PnP arm is checked before `home.state` rather than after it: under PnP
        // the install the other arm prescribes is the one the user has already done.
        withPnp()

        expect(scaffold(root).output).not.toContain('add -D dogear-cli')
        expect(scaffold(root).output).not.toContain('npm i -D dogear-cli')
      })

      it('still gives a verdict on a re-run, because it is a remark', () => {
        withPnp()
        scaffold(root)

        const output = scaffold(root).output

        expect(output).toContain("Yarn's PnP linker")
        expect(output).toContain('nothing changed')
      })

      it('says nothing when --agent=none wired nothing to point at it', () => {
        // Nothing names CLI_ENTRY when nothing is wired, so there is no path to warn about —
        // the guard the PnP arm was deliberately placed below.
        withPnp()

        expect(scaffold(root, { agents: [] }).output).not.toContain("Yarn's PnP linker")
      })
    })
  })

  it('reports the agent it detected above everything it changed', () => {
    // E2's ordering criterion, extended to the finding E3 added: the agent line is the single
    // input driving every change below it, so it has to be readable before them.
    const output = scaffold(root, { dryRun: true }).output
    const lines = output.split('\n')

    expect(lines.findIndex((line) => line.includes('agent:'))).toBeLessThan(
      lines.findIndex((line) => line.includes('would register')),
    )
  })
})

/**
 * #75, end to end through the runner: a repository whose only `package.json` is in `web/`, the
 * layout of a Go repository with its frontend in a subdirectory.
 *
 * Before #75 init committed `node_modules/dogear-cli/dist/cli.js` from the root here, a path no
 * install would ever create, and told the user to fix it with a root install that would have
 * created a root `package.json`. ./detect.test.ts pins where detection puts the CLI; this pins
 * what init writes and says as a result. `test-built/init.subdir.test.ts` runs what it writes.
 */
describe('scaffold() in a repository whose only package.json is in web/ (#75)', () => {
  const WEB_ENTRY = cliEntry('web')

  /** `web/package.json`, declaring the CLI unless told otherwise. */
  function webPackage(cli = true): void {
    writeFileSync(
      join(root, 'web', 'package.json'),
      JSON.stringify({
        devDependencies: { vite: '^8.2.1', ...(cli ? { 'dogear-cli': '^0.1.0' } : {}) },
      }),
    )
  }

  beforeEach(() => {
    // The shared fixture is a root package; this layout is the absence of one.
    rmSync(join(root, 'package.json'))
    rmSync(join(root, 'vite.config.ts'))
    mkdirSync(join(root, 'web'))
    writeFileSync(join(root, 'web', 'vite.config.ts'), '')
    webPackage()
  })

  it('reports where the CLI lives, among the findings and above the changes', () => {
    const lines = scaffold(root, { dryRun: true }).output.split('\n')

    expect(lines).toContain('  cli:       web/')
    expect(lines.indexOf('  cli:       web/')).toBeLessThan(
      lines.findIndex((line) => line.includes('would register')),
    )
  })

  it('writes the web/ path into the MCP registration and the prompt hook', () => {
    scaffold(root)

    const mcp = readFileSync(join(root, '.mcp.json'), 'utf8')
    const settings = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')

    expect(JSON.parse(mcp) as unknown).toMatchObject({
      mcpServers: { dogear: { args: [WEB_ENTRY, 'mcp'] } },
    })
    expect(settings).toContain(`"\${CLAUDE_PROJECT_DIR}/${WEB_ENTRY}"`)
    // The bug itself: no committed path may start at a root that has no node_modules.
    expect(mcp).not.toContain(`"${CLI_ENTRY}"`)
    expect(settings).not.toContain(`"\${CLAUDE_PROJECT_DIR}/${CLI_ENTRY}"`)
  })

  it('says nothing about installing the CLI when web/ declares it', () => {
    expect(scaffold(root).output).not.toContain('dogear-cli`')
  })

  it('names web/ and never the root when the CLI is not installed yet', () => {
    webPackage(false)

    const output = scaffold(root).output

    expect(output).toContain(
      `note: the MCP registration and the prompt hook both point at ${WEB_ENTRY}, which is ` +
        'not installed there. Run `npm i -D dogear-cli` in web so the path resolves for ' +
        'everyone who clones this repository.',
    )
    expect(output).not.toContain('at the repo root')
  })

  it('names the manager web/ installs with, from its own lockfile', () => {
    webPackage(false)
    writeFileSync(join(root, 'web', 'pnpm-lock.yaml'), '')

    const output = scaffold(root).output

    expect(output).toContain('Run `pnpm add -D dogear-cli` in web')
    expect(output).toContain('then, in web: pnpm add -D dogear-vite')
  })

  it('tells the plugin install to go in web/, never at the root', () => {
    expect(scaffold(root).output).toContain('then, in web: npm i -D dogear-vite')
  })

  it('is idempotent: the second run changes nothing and says so', () => {
    scaffold(root)

    expect(scaffold(root).output).toContain('nothing changed')
  })

  it('undoes cleanly, deleting the configs it wrote whole', () => {
    scaffold(root)

    expect(unscaffold(root).exitCode).toBe(0)
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false)
  })

  /**
   * A repository init had already set up before #75 carries the root's path, and `registered()`
   * finds dogear's key either way. Without the note a re-run reported `nothing changed` over a
   * hook that failed on every prompt, which is how #75 went unseen.
   */
  describe('over configs an older init wrote with the root’s path', () => {
    beforeEach(() => {
      mkdirSync(join(root, '.claude'))
      writeFileSync(
        join(root, '.mcp.json'),
        `${JSON.stringify(
          { mcpServers: { dogear: { command: 'node', args: [CLI_ENTRY, 'mcp'] } } },
          null,
          2,
        )}\n`,
      )
      writeFileSync(
        join(root, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'node',
                    args: [`\${CLAUDE_PROJECT_DIR}/${CLI_ENTRY}`, 'hook'],
                  },
                ],
              },
            ],
          },
        }),
      )
    })

    it('notes both files, and leaves both registrations exactly as they were', () => {
      const mcp = readFileSync(join(root, '.mcp.json'), 'utf8')
      const settings = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')

      const output = scaffold(root).output

      expect(output).toContain(`note: .mcp.json registers "dogear" at ${CLI_ENTRY}`)
      expect(output).toContain(
        `note: .claude/settings.json runs the prompt hook from \${CLAUDE_PROJECT_DIR}/${CLI_ENTRY}`,
      )
      expect(output).toContain('`dogear init --undo` and then `dogear init`')
      expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(mcp)

      // The stale hook is noted, never rewritten. The tool permissions an init before #76 did
      // not write are independent of the path, so they land beside it; the hook's bytes do not
      // move, which is what "leaves it as it was" means for the part that is stale.
      const after = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
      expect(after.startsWith(settings.slice(0, -1))).toBe(true)
      expect(
        (JSON.parse(after) as { permissions?: { allow?: unknown } }).permissions?.allow,
      ).toEqual(ALLOW)
    })

    it('is repaired by the round trip the note names', () => {
      scaffold(root)
      unscaffold(root)
      scaffold(root)

      expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toContain(`"${WEB_ENTRY}"`)
      expect(scaffold(root).output).toContain('nothing changed')
    })
  })

  describe('and no package anywhere for the CLI to live in', () => {
    beforeEach(() => {
      // A Vite config and nothing else: no root package.json, no web/package.json.
      rmSync(join(root, 'web', 'package.json'))
    })

    it('wires no agent, and still sets up .dogear/', () => {
      const result = scaffold(root)

      expect(result.exitCode).toBe(0)
      expect(existsSync(join(root, QUEUE_DIR))).toBe(true)
      expect(existsSync(join(root, '.mcp.json'))).toBe(false)
      expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false)
    })

    it('says why, and what to do about it', () => {
      expect(scaffold(root).output).toContain(
        'note: dogear found no package.json that declares dogear-cli, and there is none at ' +
          'the root to install it into, so no agent was wired: every path init could commit ' +
          'would resolve nowhere. Add dogear-cli to the devDependencies of the package that ' +
          'runs your app, install it there, and re-run dogear init.',
      )
    })

    it('says so again on a re-run, and still gives a verdict', () => {
      scaffold(root)

      const output = scaffold(root).output

      expect(output).toContain('so no agent was wired')
      expect(output).toContain('nothing changed')
    })

    it('names an explicit --agent it did not apply', () => {
      const output = scaffold(root, { agents: ['claude'] }).output

      expect(output).toContain('--agent=claude was not applied for the same reason.')
      expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    })

    it('says nothing under --agent=none, which asked for nothing', () => {
      expect(scaffold(root, { agents: [] }).output).not.toContain('no agent was wired')
    })

    it('never proposes a root package.json, for the CLI or for the plugin', () => {
      const output = scaffold(root).output

      expect(output).not.toContain('at the repo root')
      expect(output).toContain('then, in web: npm i -D dogear-vite')
    })

    it('prints no cli: finding, because there is nowhere to report', () => {
      expect(scaffold(root).output).not.toContain('cli:')
    })
  })
})
