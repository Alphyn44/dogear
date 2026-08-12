import { describe, expect, it } from 'vitest'

import { SOURCE_ATTRIBUTE, stampSource } from './stamp.js'

/**
 * C1 (#15) as the issue asks for it: table-driven, against fixture source.
 *
 * `stampSource` is a pure function from source text to source text, which is the whole
 * reason the brief puts the attribute transform ahead of any runtime approach — everything
 * that can go wrong here is reachable without a browser, a React version, or a build.
 *
 * Fixtures are inline strings rather than files on disk. The unit under test takes a string
 * and a module id; giving it a real file would add a filesystem round trip and a temp
 * directory to every case without exercising one extra branch. `stamp.integration.test.ts`
 * is the counterweight that runs real files through a real dev server.
 */

const ROOT = '/repo'
const FILE = '/repo/src/App.tsx'

function stamp(code: string, id: string = FILE): ReturnType<typeof stampSource> {
  return stampSource(code, id, ROOT)
}

/** The stamped code, failing loudly rather than returning null into an assertion. */
function stamped(code: string, id: string = FILE): string {
  const result = stamp(code, id)
  if (result === null) throw new Error('expected the source to be stamped')
  return result.code
}

describe('the attribute value', () => {
  it('is file:line:col, relative to the git root', () => {
    expect(stamped('const a = <div />\n')).toBe(
      `const a = <div ${SOURCE_ATTRIBUTE}="src/App.tsx:1:11" />\n`,
    )
  })

  it('counts lines and columns from 1, anchored at the `<`', () => {
    // Both axes from 1 so the value reads the way an editor, a terminal file link and a
    // stack trace read. `<main>` opens at column 5 of line 3; `<p>` at column 7 of line 4.
    const code = [
      'export function App() {',
      '  return (',
      '    <main>',
      '      <p>hi</p>',
      '    </main>',
      '  )',
      '}',
    ].join('\n')

    const result = stamped(code)

    expect(result).toContain(`<main ${SOURCE_ATTRIBUTE}="src/App.tsx:3:5">`)
    expect(result).toContain(`<p ${SOURCE_ATTRIBUTE}="src/App.tsx:4:7">`)
  })

  it('measures columns in UTF-16 units, matching the offsets Oxc reports', () => {
    // The one finding that would have been silently wrong: Oxc's `start` is a JS string
    // index, not a UTF-8 byte offset. `"日本語"` is 5 string units and 11 bytes, so a
    // byte-based reading would put this element nine columns to the right of where it is.
    const code = 'const a = "日本語" && <div />\n'

    expect(code.indexOf('<div')).toBe(19)
    expect(stamped(code)).toContain(`${SOURCE_ATTRIBUTE}="src/App.tsx:1:20"`)
  })

  it('uses forward slashes for a nested path', () => {
    expect(stamped('const a = <div />\n', '/repo/packages/ui/src/Button.tsx')).toContain(
      `${SOURCE_ATTRIBUTE}="packages/ui/src/Button.tsx:1:11"`,
    )
  })

  it('strips the query Vite appends on an HMR re-request', () => {
    // Ids arrive as `/src/App.tsx?t=1739…`. Left on, the query would reach both Oxc's
    // language detection and the emitted path.
    expect(stamped('const a = <div />\n', `${FILE}?t=1700000000000`)).toContain(
      `${SOURCE_ATTRIBUTE}="src/App.tsx:1:11"`,
    )
  })
})

describe('which elements are stamped', () => {
  it.each([
    {
      what: 'a host element',
      code: 'const a = <div />',
      expected: true,
      why: 'lowercase names are the ones that become DOM tags',
    },
    {
      what: 'a custom element',
      code: 'const a = <my-widget />',
      expected: true,
      why: 'still a host element — it reaches the DOM under its own name',
    },
    {
      what: 'a component',
      code: 'const a = <Button />',
      expected: false,
      why: 'React would pass it through as an unknown prop; C2 walks the DOM instead',
    },
    {
      what: 'a member expression',
      code: 'const a = <Foo.Bar />',
      expected: false,
      why: 'a component reference, not a tag',
    },
    {
      what: 'an underscored component',
      code: 'const a = <_Private />',
      expected: false,
      why: 'JSX treats any non-lowercase initial as a reference',
    },
    {
      what: 'a fragment',
      code: 'const a = <>text</>',
      expected: false,
      why: 'JSXOpeningFragment has no name and renders no element',
    },
  ])('$what: $expected — $why', ({ code, expected }) => {
    expect(stamp(code) !== null).toBe(expected)
  })

  it('stamps a host element nested inside a component', () => {
    // The mixed case the table above cannot show: the component is skipped and the host
    // element inside it is not, in one pass.
    const result = stamped('const a = <Button><span>ok</span></Button>')

    expect(result).toContain(`<span ${SOURCE_ATTRIBUTE}=`)
    expect(result).not.toContain(`<Button ${SOURCE_ATTRIBUTE}=`)
  })

  it('stamps a host element nested in an attribute expression', () => {
    // The generic AST walk descends into attribute values, so this is covered for free —
    // asserted because a typed visitor written later could easily lose it.
    expect(stamped('const a = <Tip label={<b>bold</b>} />')).toContain(
      `<b ${SOURCE_ATTRIBUTE}=`,
    )
  })

  it('gives every element in a nested tree its own position', () => {
    const result = stamped('const a = (\n  <ul>\n    <li>one</li>\n  </ul>\n)')

    expect(result).toContain(`<ul ${SOURCE_ATTRIBUTE}="src/App.tsx:2:3">`)
    expect(result).toContain(`<li ${SOURCE_ATTRIBUTE}="src/App.tsx:3:5">`)
  })
})

describe('where the attribute lands', () => {
  it('goes last, so a spread cannot clobber it — acceptance criterion 4', () => {
    // JSX compiles attributes into an object literal in source order, so ours must come
    // after `{...props}` to win. Placing it first would let any parent's stale value
    // silently override the element's own.
    const result = stamped('const a = <div {...props} />')

    expect(result).toBe(
      `const a = <div {...props} ${SOURCE_ATTRIBUTE}="src/App.tsx:1:11" />`,
    )
    expect(result.indexOf('{...props}')).toBeLessThan(result.indexOf(SOURCE_ATTRIBUTE))
  })

  it('goes after a spread that follows other attributes', () => {
    const result = stamped('const a = <div id="x" {...props} />')

    expect(result.indexOf('{...props}')).toBeLessThan(result.indexOf(SOURCE_ATTRIBUTE))
  })

  it.each([
    { what: 'self-closing, no space', code: 'const a = <br/>' },
    { what: 'self-closing, spaced', code: 'const a = <br />' },
    { what: 'open tag', code: 'const a = <span>x</span>' },
    { what: 'open tag with attributes', code: 'const a = <span id="x">x</span>' },
  ])('inserts inside the tag for $what', ({ code }) => {
    const result = stamped(code)

    // The insertion sits before the closing `>` or `/>` in every form, so the tag stays
    // syntactically whole. Re-parsing is what actually proves that: a stamp placed one
    // character late would produce text content instead of an attribute.
    expect(stamp(result)).toBeNull()
    expect(result).toContain(`${SOURCE_ATTRIBUTE}="src/App.tsx:1:11"`)
  })

  it('reports the opening `<` even when attributes span several lines', () => {
    const code = ['const a = (', '  <div', '    id="x"', '  />', ')'].join('\n')

    expect(stamped(code)).toContain(`${SOURCE_ATTRIBUTE}="src/App.tsx:2:3"`)
  })

  it('adds no newline, so downstream line numbers are unchanged', () => {
    // Load-bearing for `enforce: 'pre'`: @vitejs/plugin-react compiles our output, and
    // every position it reports afterwards has to still describe the user's file.
    const code = 'const a = (\n  <ul>\n    <li>one</li>\n  </ul>\n)\n'
    const result = stamped(code)

    expect(count(result, '\n')).toBe(count(code, '\n'))
  })
})

describe('returning null — leave the module untouched', () => {
  it.each([
    {
      what: 'a file with no JSX',
      code: 'export const value = 1\n',
      id: FILE,
    },
    {
      what: 'a file that does not parse',
      code: 'const a = <div>\n',
      id: FILE,
    },
    {
      what: 'a file outside the repository',
      code: 'const a = <div />\n',
      id: '/elsewhere/src/App.tsx',
    },
    {
      what: 'a .js file, which Oxc does not parse as JSX',
      code: 'const a = <div />\n',
      id: '/repo/src/legacy.js',
    },
  ])('returns null for $what', ({ code, id }) => {
    expect(stamp(code, id)).toBeNull()
  })

  it('is silent about a parse failure', () => {
    // Deliberate: dogear cannot tell "you are mid-keystroke" from "you put a .js in
    // include", and Vite reports the real syntax error a moment later with a code frame.
    // A warning per keystroke inside a broken file would be pure noise.
    expect(() => stamp('const a = <div>\n')).not.toThrow()
  })

  it('is idempotent — a second pass finds nothing to do', () => {
    // What makes the transform safe to run twice, and what leaves a hand-written
    // data-dogear-src alone.
    const once = stamped('const a = <div />\n')

    expect(stamp(once)).toBeNull()
  })

  it('skips an already-stamped element but still stamps its unstamped sibling', () => {
    const code = `const a = <div><b ${SOURCE_ATTRIBUTE}="mine.tsx:1:1">x</b><i>y</i></div>`
    const result = stamped(code)

    expect(result).toContain(`<b ${SOURCE_ATTRIBUTE}="mine.tsx:1:1">`)
    expect(result).toContain(`<i ${SOURCE_ATTRIBUTE}="src/App.tsx:1:`)
  })
})

describe('the sourcemap', () => {
  it('comes back with the transform, so Vite does not warn about chaining', () => {
    // Without a map Vite logs "Sourcemap is likely to be incorrect" against every file
    // dogear touches — which is the entire reason magic-string is a dependency.
    const result = stamp('const a = <div />\n')

    expect(result?.map.mappings).toBeTypeOf('string')
    expect(result?.map.mappings.length).toBeGreaterThan(0)
  })
})

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}
