import { describe, expect, it } from 'vitest'

import type { StoredAnnotation } from '@dogear/queue'

import { formatQueue } from './format.js'

/** The brief's worked example, once the C epic has filled in every field. */
const FULL: StoredAnnotation = {
  id: '0199c8f4-3a21-7c5e-b3d9-1f2a4c6e8b07',
  status: 'pending',
  comment: "shade this darker, it's competing with the primary CTA",
  origin: 'http://localhost:8001',
  app: '@acme/admin',
  url: 'http://localhost:8001/settings',
  sites: [
    {
      file: 'src/components/Button.tsx',
      line: 12,
      column: 5,
      tag: 'button',
      component: 'Button',
      via: 'attribute',
    },
    {
      file: 'src/components/TabBar.tsx',
      line: 42,
      column: 7,
      tag: 'div',
      component: 'TabBar',
      via: 'attribute',
    },
  ],
  element: {
    tag: 'button',
    selector: '#settings > div.tab-bar > button:nth-of-type(2)',
    text: 'Save changes',
  },
}

/** What M0 and M1 actually produce: a comment, a selector, a text snippet. No source. */
const MINIMAL: StoredAnnotation = {
  id: '019fef13-1d76-7000-9fbf-91e24ad5889b',
  status: 'pending',
  comment: 'make this darker',
  element: {
    tag: 'button',
    selector: 'nav.tab-bar > button:nth-of-type(2)',
    text: 'Settings',
  },
}

describe('formatQueue', () => {
  it('emits nothing at all for an empty list', () => {
    // Not an empty block. The caller puts this on stdout and UserPromptSubmit injects
    // stdout verbatim, so "no pending items" has to cost zero bytes of context.
    expect(formatQueue([])).toBe('')
  })

  it('renders the brief’s worked example', () => {
    expect(formatQueue([FULL])).toBe(
      [
        '<dogear-queue count="1">',
        '[1] 0199c8f4-3a21-7c5e-b3d9-1f2a4c6e8b07 — src/components/Button.tsx:12  (Button, via attribute)',
        '    also: src/components/TabBar.tsx:42  (TabBar, via attribute)',
        '    app: @acme/admin — http://localhost:8001/settings',
        '    selector: #settings > div.tab-bar > button:nth-of-type(2)',
        '    text: "Save changes"',
        "    comment: shade this darker, it's competing with the primary CTA",
        '</dogear-queue>',
        '',
        'These are annotations left by clicking elements in the running app. Each names where',
        'the element was seen; treat the location as a strong hint, not a constraint — if it',
        'does not match, locate the element by its selector or text instead.',
        '',
        'When you have addressed an item, call dogear_resolve with its id.',
      ].join('\n'),
    )
  })

  it('renders an M0-shaped item, which has no sites at all', () => {
    // The C epic is what fills in `sites`. A formatter that assumed the finished shape
    // would print "undefined" on every line for the first two milestones.
    const output = formatQueue([MINIMAL])

    expect(output).toContain('[1] 019fef13-1d76-7000-9fbf-91e24ad5889b\n')
    expect(output).toContain('    selector: nav.tab-bar > button:nth-of-type(2)')
    expect(output).toContain('    text: "Settings"')
    expect(output).toContain('    comment: make this darker')
    expect(output).not.toContain('undefined')
    expect(output).not.toContain('also:')
  })

  it('renders an item carrying nothing but an id and a comment', () => {
    const output = formatQueue([
      { id: 'bare', status: 'pending', comment: 'this is wrong' },
    ])

    expect(output).toContain('[1] bare\n    comment: this is wrong')
    expect(output).not.toContain('undefined')
  })

  // B5's (#12) batch note. Rendered here rather than deferred to D1, because a field that
  // lands in queue.json and reaches no agent is "everything works through MCP" failing
  // quietly — and this is the one formatter the hook, the MCP server and D4's clipboard all
  // share.
  describe('the batch note', () => {
    const noted: StoredAnnotation = { ...MINIMAL, note: 'all on the settings page' }

    it('renders above the comment, as context rather than payload', () => {
      // The comment stays last and unconditional — everything above it is context for
      // finding what the comment is about, and a batch instruction is exactly that.
      expect(formatQueue([noted])).toContain(
        '    note: all on the settings page\n    comment: make this darker',
      )
    })

    it('renders nothing when the item has no note', () => {
      expect(formatQueue([MINIMAL])).not.toContain('note:')
    })

    it.each([
      { why: 'an empty string', note: '' },
      { why: 'a number that survived a hand-edit', note: 7 },
      { why: 'null', note: null },
    ])('renders nothing for $why', ({ note }) => {
      const output = formatQueue([{ ...MINIMAL, note }])

      expect(output).not.toContain('note:')
      expect(output).not.toContain('undefined')
    })

    it('repeats the note per item rather than grouping consecutive ones', () => {
      // Deliberate. "Consecutive" stops being a batch boundary once resolve and prune
      // interleave the file, and a note attributed to the wrong batch's items is worse than
      // a repeated one.
      const output = formatQueue([noted, noted])

      expect(output.match(/note: all on the settings page/g)).toHaveLength(2)
    })

    it('sits below the location lines, so the source hint still leads', () => {
      const output = formatQueue([{ ...FULL, note: 'batch-wide' }])
      const lines = output.split('\n')

      expect(lines.indexOf('    note: batch-wide')).toBeGreaterThan(
        lines.indexOf('    text: "Save changes"'),
      )
    })
  })

  it('numbers items from 1 and counts them in the opening tag', () => {
    const output = formatQueue([MINIMAL, FULL, MINIMAL])

    expect(output).toContain('<dogear-queue count="3">')
    expect(output).toContain('[1] ')
    expect(output).toContain('[2] ')
    expect(output).toContain('[3] ')
  })

  it('separates items with a blank line', () => {
    expect(formatQueue([MINIMAL, MINIMAL])).toContain(
      '    comment: make this darker\n\n[2] ',
    )
  })

  it('renders the full id, not the brief example’s shortened form', () => {
    // D2's dogear_resolve takes ids verbatim. An abbreviated id would either not match or
    // match ambiguously, and the id is the model's only handle on the item.
    expect(formatQueue([FULL])).toContain(FULL.id)
  })

  it.each([{ why: 'nothing computes staleness until D5', absent: 'stale' }])(
    'omits $absent, because $why',
    ({ absent }) => {
      expect(formatQueue([FULL])).not.toContain(absent)
    },
  )

  describe('the footer', () => {
    it('closes with the dogear_resolve instruction by default', () => {
      // D1 registered the tool, so the block may now tell the model to call it. E3 registers
      // the MCP server for every agent and never skips it, which is what makes this a
      // promise the reader can actually keep.
      expect(formatQueue([FULL])).toContain(
        '\n\nWhen you have addressed an item, call dogear_resolve with its id.',
      )
    })

    it('omits it entirely with { footer: none }', () => {
      const output = formatQueue([FULL], { footer: 'none' })

      expect(output).not.toContain('dogear_resolve')
      expect(output.endsWith('locate the element by its selector or text instead.')).toBe(
        true,
      )
    })

    it.each([{ footer: 'resolve' as const }, { footer: 'none' as const }])(
      'still renders nothing at all for an empty queue with $footer',
      ({ footer }) => {
        // The zero-bytes rule outranks the footer. A lone closing instruction with no items
        // above it would be worse than silence — it would tell the agent to resolve nothing.
        expect(formatQueue([], { footer })).toBe('')
      },
    )
  })

  it('falls back to origin when there is no url', () => {
    // The url is the page you were on; the origin is the dev server that served it. In a
    // monorepo the origin alone still tells the agent which of three apps this was.
    expect(formatQueue([{ ...FULL, url: undefined }])).toContain(
      '    app: @acme/admin — http://localhost:8001\n',
    )
  })

  it('omits the app line entirely when neither app nor origin is known', () => {
    expect(formatQueue([MINIMAL])).not.toContain('    app:')
  })

  it('renders a site with a file but no line number', () => {
    const output = formatQueue([
      { ...MINIMAL, sites: [{ file: 'src/App.tsx', component: 'App' }] },
    ])

    expect(output).toContain(
      '[1] 019fef13-1d76-7000-9fbf-91e24ad5889b — src/App.tsx  (App)',
    )
  })

  it.each([
    { why: 'sites is not an array', sites: 'nope' },
    { why: 'a site is not an object', sites: ['nope'] },
    { why: 'element is not an object', element: 'nope' },
    { why: 'the text is not a string', element: { text: 42 } },
    { why: 'the line is not a number', sites: [{ file: 'a.tsx', line: 'twelve' }] },
  ])('survives a hand-written file where $why', (overrides) => {
    // The queue is a file a human is invited to `cat` and edit. Nothing in here may throw:
    // the caller is a prompt hook, and a throw there costs the user's typed prompt.
    const output = formatQueue([{ ...MINIMAL, ...overrides }])

    expect(output).toContain('    comment: make this darker')
    expect(output).not.toContain('undefined')
  })

  it('truncates an over-long text snippet', () => {
    // The browser caps element.text at 80 characters. A hand-written file does not, and
    // this output is spent context on every prompt.
    const output = formatQueue([{ ...MINIMAL, element: { text: 'x'.repeat(500) } }])

    expect(output).toContain(`    text: "${'x'.repeat(80)}…"`)
  })

  it('escapes a text snippet containing quotes and newlines', () => {
    // JSON.stringify, not manual quoting: a newline inside the snippet would otherwise
    // forge a new line in a line-oriented format the model is being asked to parse.
    const output = formatQueue([
      { ...MINIMAL, element: { text: 'Save "now"\nor later' } },
    ])

    expect(output).toContain('    text: "Save \\"now\\"\\nor later"')
  })
})
