import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StoredAnnotation } from 'dogear-queue'
import { queuePathFor } from 'dogear-queue'

import { hook } from './hook.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dogear-hook-'))
  mkdirSync(join(root, '.git'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function annotation(overrides: Partial<StoredAnnotation> = {}): StoredAnnotation {
  return {
    id: '019fef13-1d76-7000-9fbf-91e24ad5889b',
    status: 'pending',
    comment: 'make this darker',
    element: { tag: 'button', selector: 'nav > button', text: 'Settings' },
    ...overrides,
  }
}

/** Write the queue file the way a user hand-writing one would. */
function writeQueue(items: readonly StoredAnnotation[]): void {
  writeRaw(JSON.stringify({ version: 1, updatedAt: null, items }, null, 2))
}

function writeRaw(contents: string): void {
  const queuePath = queuePathFor(root)
  mkdirSync(dirname(queuePath), { recursive: true })
  writeFileSync(queuePath, contents)
}

/** The hook's stdout, parsed. Fails loudly rather than returning a half-checked object. */
function envelopeOf(output: string): {
  hookSpecificOutput: { hookEventName: string; additionalContext: string }
  suppressOutput: boolean
} {
  return JSON.parse(output)
}

describe('hook()', () => {
  describe('AC: pending items reach the agent', () => {
    it('emits the queue as additionalContext on a UserPromptSubmit envelope', () => {
      writeQueue([annotation()])

      const result = hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere')
      const envelope = envelopeOf(result.output)

      expect(result.exitCode).toBe(0)
      expect(envelope.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
      expect(envelope.hookSpecificOutput.additionalContext).toContain(
        'comment: make this darker',
      )
    })

    it('carries the comment and the file path — the story’s first criterion', () => {
      writeQueue([
        annotation({
          comment: 'this needs to be two tabs over',
          sites: [{ file: 'src/layouts/Sidebar.tsx', line: 88, component: 'Sidebar' }],
        }),
      ])

      const context = envelopeOf(hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere').output)
        .hookSpecificOutput.additionalContext

      expect(context).toContain('src/layouts/Sidebar.tsx:88')
      expect(context).toContain('comment: this needs to be two tabs over')
    })

    it('suppresses transcript output while still injecting context', () => {
      // The context reaches the model; it just does not appear above every prompt typed.
      writeQueue([annotation()])

      expect(
        envelopeOf(hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere').output),
      ).toMatchObject({ suppressOutput: true })
    })

    it('writes valid JSON and nothing else, so stdout parses as an envelope', () => {
      // Plain stdout is ALSO injected as context for this event. Anything outside the JSON
      // would arrive in the model's context as loose text.
      writeQueue([annotation()])

      expect(() =>
        envelopeOf(hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere').output),
      ).not.toThrow()
    })
  })

  describe('AC: only pending items appear', () => {
    it('drops resolved items', () => {
      writeQueue([
        annotation({ id: 'resolved-1', status: 'resolved', comment: 'already handled' }),
        annotation({ id: 'pending-1', comment: 'still open' }),
      ])

      const context = envelopeOf(hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere').output)
        .hookSpecificOutput.additionalContext

      expect(context).toContain('still open')
      expect(context).not.toContain('already handled')
      expect(context).toContain('count="1"')
    })

    it('emits nothing when every item is resolved', () => {
      writeQueue([annotation({ status: 'resolved' })])

      expect(hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere')).toEqual({
        output: '',
        exitCode: 0,
      })
    })
  })

  describe('AC: exits 0 in every case, emitting nothing on stdout', () => {
    // Exit code 2 blocks AND ERASES the user's prompt, and any non-zero exit is surfaced as
    // a hook failure. Every one of these is a case a real user hits.
    it('when the queue file does not exist', () => {
      expect(hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere')).toEqual({
        output: '',
        exitCode: 0,
      })
    })

    it('when the queue exists but holds no items', () => {
      writeQueue([])

      expect(hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere')).toEqual({
        output: '',
        exitCode: 0,
      })
    })

    it.each([
      { why: 'the JSON is truncated', contents: '{"version":1,"items":[' },
      { why: 'the file was emptied', contents: '' },
      { why: 'the file is an array', contents: '[]' },
      {
        why: 'the schema version is from the future',
        contents: '{"version":9,"items":[]}',
      },
      { why: 'items is missing', contents: '{"version":1}' },
    ])('when $why', ({ contents }) => {
      writeRaw(contents)

      const result = hook({ CLAUDE_PROJECT_DIR: root }, '/nowhere')

      expect(result.exitCode).toBe(0)
      expect(result.output).toBe('')
      // The developer hears about it on stderr, which is not injected as context.
      expect(result.diagnostic).toContain('dogear:')
    })

    it('when there is no git repository anywhere above the start directory', () => {
      const orphan = mkdtempSync(join(tmpdir(), 'dogear-orphan-'))
      try {
        const result = hook({ CLAUDE_PROJECT_DIR: orphan }, orphan)

        expect(result.exitCode).toBe(0)
        expect(result.output).toBe('')
        expect(result.diagnostic).toContain('no git repository')
      } finally {
        rmSync(orphan, { recursive: true, force: true })
      }
    })
  })

  describe('resolving the repository', () => {
    it('prefers CLAUDE_PROJECT_DIR over cwd', () => {
      // cwd is wherever the shell happened to be; CLAUDE_PROJECT_DIR is the session's repo.
      writeQueue([annotation({ comment: 'from the project dir' })])

      const result = hook({ CLAUDE_PROJECT_DIR: root }, tmpdir())

      expect(result.output).toContain('from the project dir')
    })

    it('falls back to cwd when CLAUDE_PROJECT_DIR is unset', () => {
      // Someone running `dogear hook` by hand to see what it emits has no such variable.
      writeQueue([annotation({ comment: 'from the cwd' })])

      expect(hook({}, root).output).toContain('from the cwd')
    })

    it('walks up to the git root from a subdirectory', () => {
      // A session opened in packages/app must read the same queue the dev server wrote at
      // the repo root. One repo is one queue.
      writeQueue([annotation({ comment: 'at the root' })])
      const nested = join(root, 'packages', 'app')
      mkdirSync(nested, { recursive: true })

      expect(hook({ CLAUDE_PROJECT_DIR: nested }, '/nowhere').output).toContain(
        'at the root',
      )
    })
  })
})
