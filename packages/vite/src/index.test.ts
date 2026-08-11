import type { HtmlTagDescriptor } from 'vite'
import { describe, expect, it } from 'vitest'

import { CLIENT_SOURCE } from './client.js'
import { dogear } from './index.js'
import { SENTINEL } from './sentinel.js'

describe('dogear()', () => {
  it.each([
    {
      field: 'name',
      expected: 'dogear',
      why: 'Vite identifies plugins by name in errors and ordering',
    },
    {
      field: 'apply',
      expected: 'serve',
      why: 'the primary production defense — the plugin must not exist during build',
    },
    {
      field: 'enforce',
      expected: 'pre',
      why: 'C1 needs to see real JSX, not the React plugin output',
    },
  ] as const)('sets $field to "$expected" — $why', ({ field, expected }) => {
    expect(dogear()[field]).toBe(expected)
  })

  it('returns a fresh object per call, so two Vite roots cannot share mutable state', () => {
    expect(dogear()).not.toBe(dogear())
  })
})

function injectedTags(): HtmlTagDescriptor[] {
  const hook = dogear().transformIndexHtml
  if (typeof hook !== 'object') {
    throw new Error('expected transformIndexHtml in object form, so `order` is explicit')
  }

  // Vite declares the handler with a plugin-context `this` and `(html, ctx)` parameters.
  // dogear's implementation reads none of them — it injects the same tag on every HTML
  // entry — so this narrows the declared type to the signature actually written. The
  // assertions below are what hold that claim honest; a handler that started reading its
  // arguments would return something these tests reject.
  const handler = hook.handler as unknown as () => HtmlTagDescriptor[]

  return handler()
}

describe('transformIndexHtml (A1)', () => {
  it('runs in the post bucket, so the inline script is emitted verbatim', () => {
    const hook = dogear().transformIndexHtml
    // `pre` would hand the tag to Vite's core HTML handling, which extracts inline module
    // scripts into html-proxy modules. Nothing here needs that.
    expect(typeof hook === 'object' ? hook.order : undefined).toBe('post')
  })

  it('injects exactly one tag — a second dogear script would double every handler in B1', () => {
    expect(injectedTags()).toHaveLength(1)
  })

  it.each([
    {
      property: 'tag',
      read: (tag: HtmlTagDescriptor) => tag.tag,
      expected: 'script',
      why: 'the whole feature is a script the user never imported',
    },
    {
      property: 'injectTo',
      read: (tag: HtmlTagDescriptor) => tag.injectTo,
      expected: 'head-prepend',
      why: 'dogear runs before the app module, which is where B1 will need it',
    },
    {
      property: 'attrs.type',
      read: (tag: HtmlTagDescriptor) => tag.attrs?.['type'],
      expected: 'module',
      why: 'B1 replaces the body with a module import of @dogear/core',
    },
    {
      property: 'attrs.data-dogear',
      read: (tag: HtmlTagDescriptor) => tag.attrs?.['data-dogear'],
      expected: SENTINEL,
      why: 'the attribute is what carries the sentinel into served HTML',
    },
  ])('sets $property to "$expected" — $why', ({ read, expected }) => {
    const tag = injectedTags()[0]
    expect(tag).toBeDefined()
    expect(read(tag as HtmlTagDescriptor)).toBe(expected)
  })

  it('carries the sentinel in the script body as well as the attribute', () => {
    // Two carriers, because which one a hypothetical leak would preserve is exactly the
    // thing that cannot be predicted, and check:leak is a plain substring scan.
    expect(injectedTags()[0]?.children).toBe(CLIENT_SOURCE)
    expect(CLIENT_SOURCE).toContain(SENTINEL)
  })

  it('never emits a closing script tag, which would end the element early', () => {
    expect(CLIENT_SOURCE).not.toContain('</script')
  })
})
