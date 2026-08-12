// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { createBadge } from './badge.js'

describe('createBadge', () => {
  it('starts hidden, so an untouched page renders nothing', () => {
    const badge = createBadge()

    expect(badge.visible).toBe(false)
    expect(badge.element.hidden).toBe(true)
  })

  it.each([
    { count: 1, text: '1 pending' },
    { count: 8, text: '8 pending' },
  ])('shows "$text" at $count', ({ count, text }) => {
    const badge = createBadge()

    badge.set(count)

    expect(badge.visible).toBe(true)
    expect(badge.element.textContent).toBe(text)
  })

  it('hides again at zero', () => {
    // B4 (#11) deleting the last item has to return the document to B7's idle state, not
    // leave a "0 pending" pill keeping the host mounted forever.
    const badge = createBadge()
    badge.set(2)

    badge.set(0)

    expect(badge.visible).toBe(false)
  })

  it('carries no inline style — the shadow sheet owns its appearance', () => {
    const badge = createBadge()

    expect(badge.element.getAttribute('style')).toBe(null)
    expect(badge.element.className).toBe('badge')
  })

  it('announces the count without giving up its control role', () => {
    // aria-live rather than role="status": role would override the button role and the
    // thing would stop being announced as operable.
    const badge = createBadge()

    expect(badge.element.getAttribute('aria-live')).toBe('polite')
    expect(badge.element.getAttribute('role')).toBe(null)
  })

  it('is a real button, so B4 (#11) gets focus and keyboard activation for free', () => {
    const badge = createBadge()

    expect(badge.element.tagName).toBe('BUTTON')
    // Not "submit" — inside a form, a default-type button submits it.
    expect(badge.element.type).toBe('button')
  })

  it.each([
    { expanded: true, attribute: 'true' },
    { expanded: false, attribute: 'false' },
  ])('reflects aria-expanded=$attribute', ({ expanded, attribute }) => {
    const badge = createBadge()

    badge.setExpanded(expanded)

    expect(badge.element.getAttribute('aria-expanded')).toBe(attribute)
  })

  it('starts collapsed', () => {
    expect(createBadge().element.getAttribute('aria-expanded')).toBe('false')
  })
})
