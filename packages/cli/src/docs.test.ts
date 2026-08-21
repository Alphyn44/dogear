import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { COMMANDS, usage } from './run.js'

/**
 * G1 (#42): the prose that names the CLI's commands cannot go stale silently.
 *
 * This is a source rule rather than a behaviour test, in the shape ./format.test.ts's
 * counterpart in @dogear/queue established. It exists because the drift it guards *already
 * happened*: the root README shipped four of the five commands for the whole of M1–M4, and
 * `hook` — the one an agent runs, and therefore the one nobody types and nobody misses —
 * was the one left out. Fixing that once fixes one release; pinning it fixes every release
 * after, since a sixth command now fails here rather than on a package page.
 *
 * **Both files, not just the package's own.** npm renders `packages/cli/README.md` and
 * nothing else on the package page — it does not walk up to the repository root — while a
 * reader arriving from a link reads the root one. They are two audiences with one list
 * between them, so a command missing from either is the same defect.
 *
 * Paths are relative to the repository root, which is where vitest runs from — the same
 * assumption scripts/gate/no-leaks.test.ts already makes about `examples/react-app/dist`.
 * Reading the files rather than importing them is the point: it is the shipped bytes that
 * are wrong when this fails.
 */

const ROOT_README = 'README.md'
const CLI_README = 'packages/cli/README.md'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('the root README', () => {
  const readme = read(ROOT_README)

  // A table row of backticked names — `` `init`, `hook`, … `` — so the match is the name
  // as code, not the word appearing loose in a sentence about initialisation.
  it.each(COMMANDS)('names `%s` in the @dogear/cli row', (command) => {
    expect(readme).toContain(`\`${command}\``)
  })

  it('no longer claims the product is unbuilt', () => {
    // AC 1. The banner said "The workspace is scaffolded; the product is not built yet",
    // which was true when it was written and is the first thing an arriving reader saw.
    expect(readme).not.toContain('pre-alpha')
    expect(readme).not.toContain('not built yet')
  })
})

/**
 * G3 (#44): both install surfaces must ask for the **local** `@dogear/cli`, not only the
 * global one.
 *
 * Found by running the install path rather than by reading it. Every config `dogear init`
 * writes — the MCP registration and Claude Code's prompt hook — names the repo-relative
 * `node_modules/@dogear/cli/dist/cli.js`, so a reader who followed these files exactly ended
 * up with a committed config pointing at a file that was never installed: the MCP server
 * exited 1 on spawn, and the hook did the same on every prompt. `init` says so in a note; the
 * pages a new user actually reads did not, and this is what keeps them saying it.
 */
describe('both READMEs on installing the CLI', () => {
  // A `-D` install naming the package, whatever else shares the line — the pages write it as
  // `npm i -D @dogear/vite @dogear/cli`, and which order those two appear in is prose.
  const LOCAL = /npm i -D [^\n]*@dogear\/cli/

  it.each([ROOT_README, CLI_README])('asks for a local @dogear/cli in %s', (path) => {
    expect(read(path)).toMatch(LOCAL)
  })

  it.each([ROOT_README, CLI_README])('still asks for the global one in %s', (path) => {
    expect(read(path)).toContain('npm i -g @dogear/cli')
  })
})

describe('the @dogear/cli README', () => {
  const readme = read(CLI_README)

  // `dogear <command>` rather than the bare name: this file documents commands you run,
  // and a heading that spells out the invocation is what a reader copies.
  it.each(COMMANDS)('documents `dogear %s`', (command) => {
    expect(readme).toContain(`dogear ${command}`)
  })

  it('agrees with `dogear --help` about who runs the hook', () => {
    // The one command a user must not type. Both surfaces say so, in their own words —
    // this asserts the fact survives on the page, not that the wording matches.
    expect(usage()).toContain('your agent runs this, not you')
    expect(readme).toContain('Your agent runs this, not you')
  })
})
