import { describe, expect, it } from 'vitest'

import { dogear } from './index.js'

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
