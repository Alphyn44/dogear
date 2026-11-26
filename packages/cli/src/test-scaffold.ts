import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { registryPath, shortenHome } from 'dogear-queue'
import { afterEach, beforeEach } from 'vitest'

import { createRepo, isolateGitConfig, isolateRegistry, removeRepo } from './test-repo.js'

/**
 * The repository `scaffold()`'s suites run against, and the report lines they expect (#87).
 *
 * ./scaffold.test.ts, ./scaffold.report.test.ts and ./scaffold.wiring.test.ts were one file
 * until #87. Every `scaffold()` asked git three questions, a git process costs around 40ms on
 * Windows, and vitest runs the cases in a file one after another, so that one file took longer
 * than the rest of `npm test` put together, and the run cannot finish before its slowest file.
 * Three files run on three workers, and the two whose cases never depend on git's answers stub
 * it out. What they share lives here.
 *
 * Test-only, like ./test-repo.ts, and beside the code for the same reason.
 */

/**
 * The repository under test, fresh for every case.
 *
 * Exported as a `let`, which ES modules export as a live binding: {@link useScaffoldRepo}
 * reassigns it before each case, and every importer reads the current repository rather than
 * the one that existed when it was imported.
 */
export let root: string

let restoreGitConfig: () => void
let registry: ReturnType<typeof isolateRegistry>

/** Give every case in the calling file a fresh Vite repository. Call once, at the top level. */
export function useScaffoldRepo(): void {
  beforeEach(() => {
    restoreGitConfig = isolateGitConfig()
    // E5 (#30). The last step registers the repo in the machine-level registry; without this
    // every case would write into the developer's own home directory.
    registry = isolateRegistry()
    root = createRepo('dogear-scaffold-')

    // A Vite repository, since E2 (#27): detection runs on every invocation and a repo with no
    // Vite config earns a `note:`, which suppresses `nothing changed` — so a bare temp directory
    // would quietly stop exercising E1's third criterion. ./detect.test.ts owns the shapes
    // detection can see; these suites need one that produces a clean report.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        // `dogear-cli` since E3 (#28), for the same reason `vite` is here: without it every
        // report carries the "not installed here" note, and the whole-output assertions stop
        // being about ordering. The absent case has a case of its own in
        // ./scaffold.wiring.test.ts.
        devDependencies: { vite: '^8.2.1', 'dogear-cli': '^0.1.0' },
        dependencies: { react: '^19.2.0' },
      }),
    )
    writeFileSync(join(root, 'vite.config.ts'), '')
  })

  afterEach(() => {
    removeRepo(root)
    registry.restore()
    restoreGitConfig()
  })
}

/**
 * How E5's (#30) registry step names its target.
 *
 * Computed rather than written out: `isolateRegistry()` picks a fresh temp directory per test,
 * and on Windows `tmpdir()` sits under the home directory, so `shortenHome` collapses it to a
 * `~/…` path a literal could not predict.
 */
export function registryLabel(): string {
  return shortenHome(registryPath(process.env))
}

/** The report's first line, which names the root init actually resolved. */
export function header(): string {
  return `dogear: ${root}`
}

/**
 * E2's detection lines for the fixture above, indented as the report indents them.
 *
 * Spelled out rather than matched loosely, because they now sit between the header and every
 * change line — a suite that skipped past them would stop noticing if they moved.
 */
export const VITE_FINDINGS = [
  '  vite:      vite.config.ts (vite ^8.2.1)',
  '  framework: react ^19.2.0',
  '  workspace: single package, 1 app',
]

/**
 * The findings, including E3's (#28) agent line.
 *
 * **It is a parameter because the answer legitimately changes between runs.** A fresh temp repo
 * has no agent marker, so the first init reports `none detected` and wires `.mcp.json` anyway —
 * the portable default. That run creates `.claude/settings.json`, so the *second* init detects
 * Claude Code. Both are correct, and a constant would have hidden the transition.
 */
export function findings(agent = 'none detected'): readonly string[] {
  return [...VITE_FINDINGS, `  agent:     ${agent}`]
}

/** E3's three change lines, between the config file and `.gitignore`. */
export const WIRING = [
  '  registered dogear in .mcp.json',
  '  created AGENTS.md',
  '  created .claude/settings.json',
]

/**
 * A `vite.config.ts` that actually calls the plugin — the other half of being wired, and the
 * one the shared fixture above deliberately lacks. G3 (#44) split the two: the fixture's empty
 * config makes every case the unwired baseline, and a case asserting silence has to set both
 * this and the manifest declaration.
 */
export const WIRED_CONFIG = [
  "import { dogear } from 'dogear-vite'",
  '',
  'export default { plugins: [dogear()] }',
  '',
].join('\n')

/**
 * E8's trailing block for the same fixture, which declares no `dogear-vite` — unindented,
 * because the snippet's own leading whitespace is content the user copies.
 *
 * Every whole-output assertion carries it. That is the point of spelling it out rather than
 * trimming it off: this block is the last thing the command prints and the only part of the
 * output the user is meant to act on, so a change to it should fail the cases that pin the
 * shape of the whole report.
 */
export const BLOCK = [
  '',
  'add dogear to vite.config.ts:',
  '',
  "  import { dogear } from 'dogear-vite'",
  '',
  '  export default defineConfig({',
  '    plugins: [dogear()],',
  '  })',
  '',
  'then, at the repo root: npm i -D dogear-vite',
]
