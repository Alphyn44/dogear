import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_HOSTS, isAllowedHost, isCurrentHostAllowed } from './host.js'
import {
  DEFAULT_HOSTS as NOOP_DEFAULT_HOSTS,
  isAllowedHost as noopIsAllowedHost,
  isCurrentHostAllowed as noopIsCurrentHostAllowed,
} from './noop.js'

/**
 * F3 — the runtime hostname bail.
 *
 * The allowed rows are the easy half. The denied rows are the ticket: an allow-list of
 * hostnames goes wrong at the suffix, and every near-miss below is a real shape an attacker
 * or a misconfiguration produces — a host that *contains* an allowed one, a host that ends
 * in an allowed one without a label boundary, and the bare form of a wildcard's suffix.
 */

describe('isAllowedHost — allowed', () => {
  it.each([
    { hostname: 'localhost', why: 'the obvious one' },
    { hostname: 'LOCALHOST', why: 'hostnames are case-insensitive' },
    { hostname: 'localhost.', why: 'the FQDN root form resolves to loopback too' },
    { hostname: 'app.localhost', why: 'RFC 6761 reserves the whole TLD to loopback' },
    { hostname: 'admin.api.localhost', why: 'any depth under a reserved TLD' },
    { hostname: '127.0.0.1', why: 'loopback' },
    { hostname: '127.0.0.53', why: 'all of 127.0.0.0/8 is loopback, not just .1' },
    { hostname: '127.255.255.255', why: 'the top of the loopback /8' },
    {
      hostname: '[::1]',
      why: 'the bracketed form a browser reports in location.hostname',
    },
    { hostname: '::1', why: 'the bare form a config file or a Host header carries' },
    { hostname: 'printer.local', why: 'mDNS' },
    { hostname: 'MyMac.Local', why: 'mDNS, as macOS cases it' },
    { hostname: '10.0.0.1', why: 'private /8' },
    { hostname: '10.255.255.254', why: 'the top of the private /8' },
    { hostname: '172.16.0.1', why: 'the bottom of the private /12' },
    { hostname: '172.31.255.255', why: 'the top of the private /12' },
    { hostname: '192.168.1.1', why: 'the address a phone on the LAN uses' },
  ])('$hostname — $why', ({ hostname }) => {
    expect(isAllowedHost(hostname)).toBe(true)
  })
})

describe('isAllowedHost — denied', () => {
  it.each([
    { hostname: '', why: 'file:// and about:srcdoc have no hostname to judge' },
    { hostname: '   ', why: 'whitespace is not a hostname either' },
    { hostname: 'example.com', why: 'the ordinary case this whole layer exists for' },

    // The near-misses. Each one is an allow-list bug that has shipped in real software.
    { hostname: 'notlocalhost', why: 'contains an allowed host but is not one' },
    { hostname: 'localhost.evil.com', why: 'prefix, not suffix' },
    { hostname: 'evil-localhost', why: 'no label boundary' },
    { hostname: 'mylocalhost', why: 'no label boundary, suffix form' },
    { hostname: '127.0.0.1.evil.com', why: 'an IP as a label of someone else’s domain' },
    { hostname: '192.168.1.1.attacker.net', why: 'the same trick with a private range' },
    { hostname: '10.0.0.1.evil.com', why: 'and again with the /8' },
    { hostname: 'local', why: '*.local means a subdomain of local, not local itself' },
    {
      hostname: 'localhost.local.evil.com',
      why: 'two allowed labels, neither at the end',
    },
    { hostname: 'evil.com.local.attacker.net', why: '.local buried mid-hostname' },

    // CIDR boundaries — off-by-one on either side of each private range.
    { hostname: '126.255.255.255', why: 'one below the loopback /8' },
    { hostname: '128.0.0.1', why: 'one above the loopback /8' },
    { hostname: '9.255.255.255', why: 'one below the private /8' },
    { hostname: '11.0.0.1', why: 'one above the private /8' },
    {
      hostname: '172.15.255.255',
      why: 'one below the private /12 — the classic mistake',
    },
    { hostname: '172.32.0.1', why: 'one above the private /12 — the other half of it' },
    { hostname: '192.167.255.255', why: 'one below the private /16' },
    { hostname: '192.169.0.1', why: 'one above the private /16' },
    { hostname: '169.254.1.1', why: 'IPv4 link-local is deliberately not on the list' },
    { hostname: '8.8.8.8', why: 'a public address' },

    // Shapes that are not addresses at all, and must not be coerced into one.
    {
      hostname: '010.0.0.1',
      why: 'leading zeros are octal-ambiguous, so not a valid quad',
    },
    { hostname: '10.0.0.256', why: 'out of range octet' },
    { hostname: '10.0.0', why: 'too few octets' },
    { hostname: '10.0.0.1.1', why: 'too many octets' },
    { hostname: 'localhost:5173', why: 'a host:port is not a hostname and fails closed' },
    { hostname: '[fd12::1]', why: 'IPv6 unique-local is deferred, so it is denied' },
    { hostname: '[fe80::1]', why: 'IPv6 link-local is deferred, so it is denied' },
    { hostname: '0:0:0:0:0:0:0:1', why: 'IPv6 is matched exactly, never canonicalised' },
  ])('$hostname — $why', ({ hostname }) => {
    expect(isAllowedHost(hostname)).toBe(false)
  })
})

describe('isAllowedHost — a caller-supplied list', () => {
  // E7 (#40) will pass `hosts` from .dogear/config.json. The contract it inherits is that
  // the list REPLACES the defaults: someone who narrows it is narrowing it, not adding to
  // a hidden allowance underneath.
  it('narrowing the list stops allowing what the defaults allowed', () => {
    expect(isAllowedHost('192.168.1.1')).toBe(true)
    expect(isAllowedHost('192.168.1.1', ['localhost'])).toBe(false)
  })

  it('allows what the list names and nothing else', () => {
    expect(isAllowedHost('dev.acme.test', ['*.acme.test'])).toBe(true)
    expect(isAllowedHost('localhost', ['*.acme.test'])).toBe(false)
  })

  it('normalises the pattern as well as the hostname', () => {
    expect(isAllowedHost('[::1]', ['::1'])).toBe(true)
    expect(isAllowedHost('::1', ['[::1]'])).toBe(true)
    expect(isAllowedHost('localhost', ['LocalHost.'])).toBe(true)
  })

  it('denies everything when given an empty list', () => {
    expect(isAllowedHost('localhost', [])).toBe(false)
  })

  it.each([
    { pattern: '10.0.0.0/', why: 'an empty prefix must not be read as /0' },
    { pattern: '10.0.0.0/33', why: 'a prefix wider than the address space' },
    { pattern: '10.0.0.0/8/8', why: 'two prefixes' },
    { pattern: '10.0.0/8', why: 'a network that is not a dotted quad' },
  ])('ignores the malformed CIDR $pattern — $why', ({ pattern }) => {
    // The dangerous failure mode is a typo that widens the list rather than narrowing it:
    // `Number('')` is 0, so an unguarded `10.0.0.0/` would have become "match every IPv4
    // address on the internet".
    expect(isAllowedHost('8.8.8.8', [pattern])).toBe(false)
    expect(isAllowedHost('10.0.0.1', [pattern])).toBe(false)
  })

  it('matches every address for an explicit /0, which is what /0 means', () => {
    // Not a recommendation — a documented consequence. Someone who writes `0.0.0.0/0` has
    // disabled the layer, and should get what they asked for rather than a silent no-op.
    expect(isAllowedHost('8.8.8.8', ['0.0.0.0/0'])).toBe(true)
    expect(isAllowedHost('not-an-address', ['0.0.0.0/0'])).toBe(false)
  })
})

describe('DEFAULT_HOSTS', () => {
  it('is frozen, so a caller cannot widen the defaults for the whole process', () => {
    expect(Object.isFrozen(DEFAULT_HOSTS)).toBe(true)
  })

  it('carries the private ranges rather than leaving them to a separate rule', () => {
    // The brief's Config block and its layer-5 prose disagreed on this; the resolution is
    // that `hosts` is the single source of truth. See the Decisions log.
    expect(DEFAULT_HOSTS).toContain('10.0.0.0/8')
    expect(DEFAULT_HOSTS).toContain('172.16.0.0/12')
    expect(DEFAULT_HOSTS).toContain('192.168.0.0/16')
  })
})

describe('isCurrentHostAllowed', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is false when there is no location at all', () => {
    // The default in this suite (environment: 'node'), and the real case for a worker or
    // a non-DOM context. No origin means nothing to call local.
    expect(isCurrentHostAllowed()).toBe(false)
  })

  it.each([
    { hostname: 'localhost', allowed: true },
    { hostname: '[::1]', allowed: true },
    { hostname: '192.168.1.42', allowed: true },
    { hostname: 'app.acme.com', allowed: false },
    { hostname: 'localhost.evil.com', allowed: false },
    { hostname: '', allowed: false },
  ])('reads location.hostname: $hostname → $allowed', ({ hostname, allowed }) => {
    vi.stubGlobal('location', { hostname })
    expect(isCurrentHostAllowed()).toBe(allowed)
  })

  it('is false when location exists without a hostname', () => {
    vi.stubGlobal('location', {})
    expect(isCurrentHostAllowed()).toBe(false)
  })
})

describe('the noop build (F1, layer 3)', () => {
  // noop.ts hand-writes these rather than re-exporting ./host.js, so they need their own
  // assertions — the surface comparison in index.test.ts proves the names exist, not that
  // they are inert. The production module must deny even the hosts the real one allows.
  it.each(['localhost', '127.0.0.1', '[::1]', '192.168.1.1', 'example.com'])(
    'denies %s',
    (hostname) => {
      expect(noopIsAllowedHost(hostname)).toBe(false)
    },
  )

  it('denies the current host whatever it is', () => {
    vi.stubGlobal('location', { hostname: 'localhost' })
    expect(noopIsCurrentHostAllowed()).toBe(false)
    vi.unstubAllGlobals()
  })

  it('ships no default hosts, and no matcher to apply them with', () => {
    expect(NOOP_DEFAULT_HOSTS).toEqual([])
    expect(Object.isFrozen(NOOP_DEFAULT_HOSTS)).toBe(true)
  })
})
