import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mcp } from './mcp.js'
import { isServe } from './run.js'

/**
 * The command adapter, not the protocol. ../test-built/mcp.test.ts drives a real client
 * against the built binary; everything here is about what `dogear mcp` decides before any
 * of that starts.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-mcp-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('mcp()', () => {
  it('hands back a serving outcome inside a repository', () => {
    mkdirSync(join(root, '.git'))

    expect(isServe(mcp(root))).toBe(true)
  })

  it('walks up to the git root, so a client spawning in a subdirectory still works', () => {
    // Clients differ on the cwd they spawn a server with, and in a monorepo it is routinely
    // a package. One repo is one queue, so the walk has to reach the same file the dev
    // server wrote.
    mkdirSync(join(root, '.git'))
    const nested = join(root, 'packages', 'apps', 'admin')
    mkdirSync(nested, { recursive: true })

    expect(isServe(mcp(nested))).toBe(true)
  })

  it('FAILS LOUDLY outside a repository, unlike the hook', () => {
    // The deliberate asymmetry. `hook()` exits 0 in silence here because a non-zero exit
    // from UserPromptSubmit is surfaced as a failure and exit 2 erases the user's prompt.
    // A server has neither constraint and the opposite need: one that started anyway would
    // answer "no annotations" forever, which reads as an empty queue rather than a broken
    // install.
    const outcome = mcp(root)

    expect(isServe(outcome)).toBe(false)
    if (isServe(outcome)) return

    expect(outcome.exitCode).toBe(1)
    expect(outcome.output).toContain(root)
    expect(outcome.output).toContain('no git repository')
  })

  it('decides without starting anything — serve() is a continuation, not a side effect', () => {
    // Constructing the outcome must not touch stdio or load the SDK. The laziness itself is
    // asserted where it is actually observable: ../test-built/mcp.test.ts checks that the
    // built dist/cli.js has no top-level SDK import, and ../test-built/hook.test.ts's 2s
    // budget is what fails if that regresses.
    mkdirSync(join(root, '.git'))
    const outcome = mcp(root)

    expect(isServe(outcome) && typeof outcome.serve).toBe('function')
  })
})
