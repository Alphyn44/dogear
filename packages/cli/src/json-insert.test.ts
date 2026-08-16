import { describe, expect, it } from 'vitest'

import { insertAt } from './json-insert.js'

/**
 * The guard on E3's (#28) central promise: `dogear init` adds a member to the user's JSON and
 * changes nothing else.
 *
 * Two assertions carry most of the weight and both are here rather than in the step suites,
 * because they are properties of the primitive rather than of any caller: **the result parses**,
 * and **every line that was there before is still there, byte for byte**. The second is what a
 * re-serialising implementation would fail while looking perfectly correct in a diff of the
 * parsed value.
 */

/** Every line of `before` still present, in order, in `after`. */
function preservesLines(before: string, after: string): boolean {
  const remaining = after.split(/\r?\n/)
  let cursor = 0

  for (const line of before.split(/\r?\n/)) {
    const found = remaining.indexOf(line, cursor)
    // A line that gained a trailing comma is the one edit splice() is allowed to make.
    if (found === -1) {
      const withComma = remaining.indexOf(`${line},`, cursor)
      if (withComma === -1) return false
      cursor = withComma + 1
      continue
    }
    cursor = found + 1
  }

  return true
}

describe('insertAt() placing a member', () => {
  const cases: readonly {
    readonly name: string
    readonly source: string
    readonly path: readonly string[]
    readonly snippet: string
    readonly expected: unknown
    /**
     * The container had to open up to receive a member, so the line holding it was split.
     *
     * `{}` cannot gain a member and stay one line, and neither can `{ "a": 1 }` without being
     * reflowed. That is the one edit the byte-preservation promise does not cover, and it is
     * exempted here explicitly rather than by loosening the check — every case *without* this
     * flag is the real-world shape, and stays strict.
     */
    readonly expands?: true
  }[] = [
    {
      name: 'into a populated root object',
      source: '{\n  "a": 1\n}\n',
      path: [],
      snippet: '"b": 2',
      expected: { a: 1, b: 2 },
    },
    {
      name: 'into an empty root object',
      source: '{}\n',
      path: [],
      snippet: '"b": 2',
      expected: { b: 2 },
      expands: true,
    },
    {
      name: 'into a nested object',
      source: '{\n  "hooks": {\n    "Stop": []\n  }\n}\n',
      path: ['hooks'],
      snippet: '"UserPromptSubmit": []',
      expected: { hooks: { Stop: [], UserPromptSubmit: [] } },
    },
    {
      name: 'into an empty nested object',
      source: '{\n  "hooks": {}\n}\n',
      path: ['hooks'],
      snippet: '"UserPromptSubmit": []',
      expected: { hooks: { UserPromptSubmit: [] } },
      expands: true,
    },
    {
      name: 'onto a populated array',
      source:
        '{\n  "hooks": {\n    "UserPromptSubmit": [\n      { "id": 1 }\n    ]\n  }\n}\n',
      path: ['hooks', 'UserPromptSubmit'],
      snippet: '{ "id": 2 }',
      expected: { hooks: { UserPromptSubmit: [{ id: 1 }, { id: 2 }] } },
    },
    {
      name: 'onto an empty array',
      source: '{\n  "hooks": {\n    "UserPromptSubmit": []\n  }\n}\n',
      path: ['hooks', 'UserPromptSubmit'],
      snippet: '{ "id": 2 }',
      expected: { hooks: { UserPromptSubmit: [{ id: 2 }] } },
      expands: true,
    },
    {
      name: 'past a sibling whose value is a string holding a closing brace',
      source: '{\n  "command": "bash \\"a}b\\"",\n  "a": 1\n}\n',
      path: [],
      snippet: '"b": 2',
      expected: { command: 'bash "a}b"', a: 1, b: 2 },
    },
    {
      name: 'past a sibling whose value is a string holding a comma and a bracket',
      source: '{\n  "args": ["x,]y"],\n  "a": 1\n}\n',
      path: [],
      snippet: '"b": 2',
      expected: { args: ['x,]y'], a: 1, b: 2 },
    },
    {
      name: 'past a sibling whose value ends in an escaped backslash',
      source: '{\n  "path": "C:\\\\",\n  "a": 1\n}\n',
      path: [],
      snippet: '"b": 2',
      expected: { path: 'C:\\', a: 1, b: 2 },
    },
    {
      name: 'past scalar siblings of every kind',
      source: '{\n  "n": -1.5e3,\n  "t": true,\n  "f": false,\n  "z": null\n}\n',
      path: [],
      snippet: '"b": 2',
      expected: { n: -1500, t: true, f: false, z: null, b: 2 },
    },
    {
      name: 'into an object written inline',
      source: '{ "a": 1 }\n',
      path: [],
      snippet: '"b": 2',
      expected: { a: 1, b: 2 },
      expands: true,
    },
    {
      name: 'into a deeply nested path',
      source: '{\n  "a": {\n    "b": {\n      "c": {}\n    }\n  }\n}\n',
      path: ['a', 'b', 'c'],
      snippet: '"d": 1',
      expected: { a: { b: { c: { d: 1 } } } },
      expands: true,
    },
  ]

  it.each(cases)('$name', ({ source, path, snippet, expected, expands }) => {
    const result = insertAt(source, path, snippet)

    expect(result).toBeDefined()
    expect(JSON.parse(result as string)).toEqual(expected)
    if (expands !== true) expect(preservesLines(source, result as string)).toBe(true)
  })
})

describe('insertAt() matching the file it is given', () => {
  it('keeps a four-space file on four spaces', () => {
    const source = '{\n    "a": 1\n}\n'
    const result = insertAt(source, [], '"b": 2') as string

    expect(result).toBe('{\n    "a": 1,\n    "b": 2\n}\n')
  })

  it('keeps a tab-indented file on tabs', () => {
    const source = '{\n\t"a": 1\n}\n'
    const result = insertAt(source, [], '"b": 2') as string

    expect(result).toBe('{\n\t"a": 1,\n\t"b": 2\n}\n')
  })

  it('writes CRLF into a CRLF file', () => {
    const source = '{\r\n  "a": 1\r\n}\r\n'
    const result = insertAt(source, [], '"b": 2') as string

    expect(result).toBe('{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n')
    expect(result).not.toMatch(/[^\r]\n/)
  })

  it('indents a multi-line snippet as a block', () => {
    const source = '{\n  "a": 1\n}\n'
    const result = insertAt(source, [], '"b": {\n  "c": 2\n}') as string

    expect(result).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n')
  })

  it('leaves the trailing newline exactly as it found it', () => {
    expect(insertAt('{\n  "a": 1\n}', [], '"b": 2')).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })
})

describe('insertAt() declining', () => {
  const declined: readonly {
    readonly name: string
    readonly run: () => string | undefined
  }[] = [
    {
      name: 'a path that is not there',
      run: () => insertAt('{\n  "a": 1\n}\n', ['hooks'], '"b": 2'),
    },
    {
      name: 'a path through a scalar',
      run: () => insertAt('{\n  "a": 1\n}\n', ['a'], '"b": 2'),
    },
    {
      name: 'a path through a string',
      run: () => insertAt('{\n  "a": "x"\n}\n', ['a'], '"b": 2'),
    },
    {
      name: 'a file with comments in it',
      run: () => insertAt('{\n  // why\n  "a": 1\n}\n', [], '"b": 2'),
    },
    {
      name: 'a file that is not JSON at all',
      run: () => insertAt('not json\n', [], '"b": 2'),
    },
    {
      name: 'a truncated file',
      run: () => insertAt('{\n  "a": 1\n', [], '"b": 2'),
    },
    {
      name: 'a document whose root is an array when an object key is offered',
      run: () => insertAt('[\n  1\n]\n', [], '"b": 2'),
    },
    {
      name: 'a snippet that would not parse in place',
      run: () => insertAt('{\n  "a": 1\n}\n', [], 'not-json'),
    },
    {
      name: 'a trailing comma the parser would reject',
      run: () => insertAt('{\n  "a": 1,\n}\n', [], '"b": 2'),
    },
  ]

  it.each(declined)('declines $name', ({ run }) => {
    expect(run()).toBeUndefined()
  })
})

describe("insertAt() against this repository's own settings.json shape", () => {
  // The case that motivated the module: hand-formatted, one-line objects inside a nested array.
  // A parse-and-re-serialise implementation reformats all of it; this must not touch a byte.
  const source = [
    '{',
    '  "permissions": {',
    '    "allow": ["Read", "Glob"]',
    '  },',
    '  "hooks": {',
    '    "UserPromptSubmit": [',
    '      {',
    '        "hooks": [{ "type": "command", "command": "bash \\"chime.sh\\"" }]',
    '      }',
    '    ]',
    '  }',
    '}',
    '',
  ].join('\n')

  it('appends to UserPromptSubmit without disturbing the existing entry', () => {
    const result = insertAt(
      source,
      ['hooks', 'UserPromptSubmit'],
      '{\n  "hooks": [{ "type": "command", "command": "node" }]\n}',
    ) as string

    expect(result).toBeDefined()

    const parsed = JSON.parse(result) as {
      hooks: { UserPromptSubmit: readonly unknown[] }
    }
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(2)

    // The one-line entry survives verbatim — the whole point of the module.
    expect(result).toContain(
      '        "hooks": [{ "type": "command", "command": "bash \\"chime.sh\\"" }]',
    )
    expect(result).toContain('    "allow": ["Read", "Glob"]')
    expect(preservesLines(source, result)).toBe(true)
  })
})
