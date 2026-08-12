// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'

import type { Overlay } from './overlay.js'
import { createOverlay, HOST_TAG } from './overlay.js'
import { SHADOW_CSS } from './styles.js'

/**
 * B7 (#14), as far as a DOM without a layout engine can settle it.
 *
 * Note every test here imports `createOverlay` directly rather than going through
 * `./index.ts`. That is not a shortcut — the shadow root is `closed`, so `host.shadowRoot`
 * is `null` and the returned handle is the only way in. Direct import is the price of the
 * guarantee, and it keeps `init`'s public surface at one function with no test seams.
 */

let overlay: Overlay | undefined

afterEach(() => {
  overlay?.destroy()
  overlay = undefined
})

describe('createOverlay', () => {
  it('touches the document with nothing', () => {
    // Guarantee 2, at its most important moment: init() runs on every page load of every
    // dev server. A dogear that inserts a node merely by existing has already lost.
    const before = document.documentElement.outerHTML

    overlay = createOverlay()

    expect(document.documentElement.outerHTML).toBe(before)
    expect(overlay.mounted).toBe(false)
  })

  it(`uses a <${HOST_TAG}> host, which no app query asks for`, () => {
    // A <div> host would answer `document.querySelectorAll('div')`, which is a query real
    // apps and real snapshot helpers make. A hyphenated name costs nothing and closes it.
    overlay = createOverlay()

    expect(overlay.host.tagName.toLowerCase()).toBe(HOST_TAG)
  })

  it('is not a registered custom element — no upgrade, no lifecycle, no registry collision', () => {
    expect(customElements.get(HOST_TAG)).toBeUndefined()
  })

  it('hides its tree behind a closed shadow root', () => {
    overlay = createOverlay()

    // The app sees nothing. If happy-dom ever exposed a closed root, this fails loudly
    // rather than the guarantee quietly ceasing to hold.
    expect(overlay.host.shadowRoot).toBeNull()
    // ...while this module still has a usable handle.
    expect(overlay.root.querySelector('style')).not.toBeNull()
  })

  it('carries its styles as a <style> element, which a test can read', () => {
    overlay = createOverlay()

    expect(overlay.root.querySelector('style')?.textContent).toBe(SHADOW_CSS)
  })

  it.each([
    { property: 'position', why: 'out of flow, so nothing in the app is displaced' },
    { property: 'pointer-events', why: 'the page underneath must stay usable' },
    { property: 'z-index', why: 'a dev tool a stacking context hides does not work' },
  ])('sets $property !important inline — $why', ({ property }) => {
    // `!important` inline, not a `:host` rule: a `:host` rule loses to the outer document's
    // rules on the host, and `div { position: static !important }` in a reset is real.
    overlay = createOverlay()
    const style = (overlay.host as HTMLElement).style

    expect(style.getPropertyValue(property)).not.toBe('')
    expect(style.getPropertyPriority(property)).toBe('important')
  })
})

describe('mount and unmount', () => {
  it('appends exactly one node, outside <body>', () => {
    overlay = createOverlay()
    const bodyBefore = document.body.innerHTML
    const childrenBefore = document.documentElement.children.length

    overlay.mount()

    expect(overlay.mounted).toBe(true)
    expect(document.documentElement.children.length).toBe(childrenBefore + 1)
    expect(overlay.host.parentElement).toBe(document.documentElement)
    // The assertion that matters for snapshot churn: Testing Library and most snapshot
    // helpers serialize document.body or a container inside it.
    expect(document.body.innerHTML).toBe(bodyBefore)
  })

  it('restores the document byte-for-byte on unmount', () => {
    overlay = createOverlay()
    const before = document.documentElement.outerHTML

    overlay.mount()
    overlay.unmount()

    // outerHTML rather than a child count, because it also catches a stray attribute or
    // text node. A closed shadow root does not serialize, which is a second reason the host
    // itself has to be gone rather than merely emptied — an emptied host would compare
    // identical to a full one here.
    expect(document.documentElement.outerHTML).toBe(before)
  })

  it.each([
    { action: 'mount', why: 'a second modifier press must not stack two hosts' },
    { action: 'unmount', why: 'teardown after a disarm must not throw' },
  ] as const)('$action is idempotent — $why', ({ action }) => {
    overlay = createOverlay()
    const childrenBefore = document.documentElement.children.length

    overlay.mount()
    overlay[action]()
    overlay[action]()

    expect(document.documentElement.children.length).toBe(
      action === 'mount' ? childrenBefore + 1 : childrenBefore,
    )
  })

  it('reuses the same host across cycles, keeping the shadow tree alive', () => {
    // attachShadow can only be called once per element, so rebuilding the host on every
    // arm would mean rebuilding the whole tree. Re-appending a detached node is free.
    overlay = createOverlay()
    const { host, root } = overlay

    overlay.mount()
    overlay.unmount()
    overlay.mount()

    expect(overlay.host).toBe(host)
    expect(overlay.root).toBe(root)
    expect(root.querySelector('style')?.textContent).toBe(SHADOW_CSS)
  })

  it('will not remount after destroy', () => {
    // The teardown ordering in init.ts detaches listeners before destroying the overlay,
    // but a handler already on the stack could still call mount(). This is the backstop.
    overlay = createOverlay()
    overlay.mount()
    const before = document.documentElement.outerHTML.replace(
      /<dogear-overlay[^>]*><\/dogear-overlay>/,
      '',
    )

    overlay.destroy()
    overlay.mount()

    expect(overlay.mounted).toBe(false)
    expect(document.documentElement.outerHTML).toBe(before)
  })
})
