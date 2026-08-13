import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SENTINEL } from '../packages/core/src/sentinel.js'
import { formatFindings, scanBuildOutput, scanManifest } from './check-leak.js'

/**
 * These tests exist because the gate cannot prove itself. On a healthy repo the real
 * scan finds nothing, so a scanner that always returned "clean" would pass CI forever.
 * Everything below feeds the scanner output it MUST reject.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dogear-leak-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, contents: string): string {
  const path = join(dir, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  return path
}

describe('scanBuildOutput — detection', () => {
  it.each([
    {
      rule: 'sentinel',
      contents: `var a=1;var b="${SENTINEL}";console.log(b)`,
      why: 'the dev-only marker reached a production bundle',
    },
    {
      rule: 'source-attribute',
      contents: '<div data-dogear-src="src/App.tsx:12:5">hi</div>',
      why: "C1's transform stamped production DOM",
    },
    {
      // Only the component attribute in this fixture, and only the source attribute in the
      // one above: each row asserts exactly one finding, and the two needles are not
      // substrings of one another, so neither row can trip the other's rule.
      rule: 'component-attribute',
      contents: '<div data-dogear-component="Button">hi</div>',
      why: "C5's transform stamped production DOM",
    },
    {
      rule: 'package-specifier',
      contents: 'import x from "@dogear/core"',
      why: 'dogear was in the module graph',
    },
  ])('flags $rule — $why', ({ rule, contents }) => {
    write('assets/bundle.js', contents)

    const { findings } = scanBuildOutput(dir)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.rule).toBe(rule)
    expect(findings[0]?.file).toContain('bundle.js')
  })

  it('names the offending file in the report, which is F2’s acceptance criterion', () => {
    write('assets/leaky-bundle.js', SENTINEL)

    const report = formatFindings(scanBuildOutput(dir).findings)

    expect(report).toContain('leaky-bundle.js')
    expect(report).toContain(SENTINEL)
  })

  it('reports every offending file, not just the first', () => {
    write('a.js', SENTINEL)
    write('nested/deep/b.js', SENTINEL)
    write('c.html', `<script>${SENTINEL}</script>`)

    const { findings } = scanBuildOutput(dir)

    expect(findings).toHaveLength(3)
    expect(findings.map((f) => f.file.split('/').pop()).sort()).toEqual([
      'a.js',
      'b.js',
      'c.html',
    ])
  })

  it('counts repeated occurrences rather than stopping at the first', () => {
    write('bundle.js', `${SENTINEL} middle ${SENTINEL} end ${SENTINEL}`)

    expect(scanBuildOutput(dir).findings[0]?.detail).toContain('3×')
  })

  it('walks nested directories', () => {
    write('assets/chunks/vendor/deep.js', SENTINEL)

    expect(scanBuildOutput(dir).findings).toHaveLength(1)
  })

  it('accepts a single file as well as a directory', () => {
    const file = write('noop.js', `var IS_NOOP=true;var s="${SENTINEL}"`)

    expect(scanBuildOutput(file).findings).toHaveLength(1)
  })
})

describe('scanBuildOutput — what must NOT trip it', () => {
  it('does not flag the bare word "dogear"', () => {
    // This is the real false positive, not a hypothetical: examples/react-app ships a
    // <title> and an <h1> that both say "dogear example". Grepping for the product name
    // fails on a perfectly healthy build, which is the entire reason a sentinel exists.
    write('index.html', '<title>dogear example</title><h1>dogear example</h1>')
    write(
      'bundle.js',
      'jsx("h1",{children:"dogear example"}),jsx("p",{children:"no dogear script here"})',
    )

    expect(scanBuildOutput(dir).findings).toEqual([])
  })

  it('does not flag a scoped package that merely looks similar', () => {
    write('bundle.js', 'import x from "@dogearsville/core"; import y from "dogears"')

    expect(scanBuildOutput(dir).findings).toEqual([])
  })

  it('passes a clean directory while still confirming it read something', () => {
    write('bundle.js', 'console.log("hello")')

    const result = scanBuildOutput(dir)

    expect(result.findings).toEqual([])
    expect(result.filesScanned).toBe(1)
  })

  it('skips binary files and does not count them as scanned', () => {
    writeFileSync(
      join(dir, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    )

    expect(scanBuildOutput(dir).filesScanned).toBe(0)
  })
})

describe('scanBuildOutput — refusing to pass vacuously', () => {
  it('throws when the target does not exist, rather than reporting clean', () => {
    expect(() => scanBuildOutput(join(dir, 'never-built'))).toThrowError(/does not exist/)
  })

  it('tells the caller to build, since that is always the actual fix', () => {
    expect(() => scanBuildOutput(join(dir, 'never-built'))).toThrowError(/Build first/)
  })

  it('reports zero files scanned for an empty directory, so the gate can reject it', () => {
    // An existing-but-empty dist is the same failure as a missing one. The scanner
    // reports it honestly; scripts/gate/no-leaks.test.ts is what turns it into a failure.
    expect(scanBuildOutput(dir).filesScanned).toBe(0)
  })
})

describe('scanManifest', () => {
  it.each([
    { field: 'dependencies', name: '@dogear/vite', flagged: true },
    { field: 'dependencies', name: '@dogear/core', flagged: true },
    { field: 'dependencies', name: 'dogear', flagged: true },
    { field: 'devDependencies', name: '@dogear/vite', flagged: false },
  ])('$field containing $name -> flagged=$flagged', ({ field, name, flagged }) => {
    const path = write('package.json', JSON.stringify({ [field]: { [name]: '*' } }))

    expect(scanManifest(path)).toHaveLength(flagged ? 1 : 0)
  })

  it('is quiet on a manifest with no dependencies at all', () => {
    expect(scanManifest(write('package.json', '{"name":"x"}'))).toEqual([])
  })

  it('explains why a runtime dependency is wrong', () => {
    const path = write(
      'package.json',
      JSON.stringify({ dependencies: { '@dogear/vite': '*' } }),
    )

    expect(scanManifest(path)[0]?.detail).toContain('devDependency')
  })
})

describe('formatFindings', () => {
  it('returns the empty string when clean, so the gate can assert toBe("")', () => {
    expect(formatFindings([])).toBe('')
  })

  it('points the reader at layers 1 and 3 rather than at this check', () => {
    write('bundle.js', SENTINEL)

    const report = formatFindings(scanBuildOutput(dir).findings)

    expect(report).toContain('apply: "serve"')
    expect(report).toContain('exports map')
  })
})
