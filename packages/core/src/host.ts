/**
 * The runtime hostname guard — F3, and layer 5 of the five in the brief's "Keeping it out
 * of production".
 *
 * READ THIS BEFORE CONCLUDING IT IS WHAT KEEPS DOGEAR OFF PRODUCTION SITES. It is not.
 * `apply: 'serve'` in @dogear/vite is the primary defense; the plugin does not exist during
 * `vite build`, so on a correctly built site this file is never downloaded, never parsed,
 * and never called. This is the *last* line — the one that runs only in the scenario where
 * every structural layer already failed and core is somehow live in a real user's browser.
 * Treating it as the defense would be reading the layers backwards.
 *
 * Nothing calls it yet. Core has no `init()` until B1 (#8); this ships as a pure predicate
 * plus a thin ambient reader so that `init()`'s first line can be
 * `if (!isCurrentHostAllowed()) return`.
 *
 * The bail is deliberately **silent**. A console warning here would fire precisely on a
 * deployed page in front of real users, announcing a dev tool on the one page it must be
 * invisible on. Diagnostics belong on the dev-side path, where B1 can add them.
 */

/**
 * The hosts dogear will run on, and the whole of the answer — there is no second, hidden
 * rule beside this list.
 *
 * The brief's Config block calls this `hosts` and E4 (#29) will read it from
 * `.dogear/config.json`. That file does not exist yet and nothing here reads it: F3 ships
 * the defaults and the matcher, E4 plugs the file in by passing a second argument to
 * {@link isAllowedHost}.
 *
 * Private ranges live *in* the list rather than beside it as an always-on rule. It matters
 * for E4: someone who narrows `hosts` to `["localhost"]` is telling dogear to stop running
 * on their LAN address, and a separate hard-coded private-IP allowance would silently
 * ignore them. One list means "what is allowed" has exactly one answer.
 */
export const DEFAULT_HOSTS: readonly string[] = Object.freeze([
  'localhost',
  // RFC 6761 reserves the whole .localhost TLD to loopback, which is what makes
  // `app.localhost` / `admin.localhost` a safe pattern rather than a guess. Suffix
  // matching cannot reach `localhost.evil.com` — see matchesSuffix below.
  '*.localhost',
  // The whole loopback /8, not just 127.0.0.1: 127.0.0.2+ are equally loopback and get
  // used to separate concurrent dev servers.
  '127.0.0.0/8',
  // Bare, not bracketed. A browser reports `location.hostname` as `[::1]`, and
  // normalise() strips the brackets before matching, so this one entry covers both forms.
  '::1',
  // mDNS — `mymac.local`, and the hostname a phone on the same network resolves.
  '*.local',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
])

/**
 * Is `hostname` one dogear is allowed to run on?
 *
 * Takes a hostname, never a host:port — `location.hostname` is the intended source, and a
 * `example.com:5173` string fails closed because no pattern kind can match it.
 *
 * `hosts` replaces the defaults entirely rather than extending them. That is E4's eventual
 * contract: the config file's `hosts` array is the list, not an addition to a hidden one.
 */
export function isAllowedHost(
  hostname: string,
  hosts: readonly string[] = DEFAULT_HOSTS,
): boolean {
  const host = normalise(hostname)

  // Denied rather than allowed. An empty hostname is `file://`, `about:srcdoc`, and a few
  // worker contexts — no origin, so nothing to call local, so no reason to run.
  if (host === '') return false

  return hosts.some((pattern) => matches(host, normalise(pattern)))
}

/**
 * The ambient form: is the page dogear is currently running on a local one?
 *
 * `globalThis.location` rather than `window.location` so this is answerable from a worker
 * or a non-DOM context without throwing. Its absence is treated as "not local", for the
 * same reason an empty hostname is: there is no origin to judge.
 */
export function isCurrentHostAllowed(): boolean {
  const hostname = (globalThis as { location?: { hostname?: string } }).location?.hostname
  return hostname === undefined ? false : isAllowedHost(hostname)
}

/**
 * Lowercase, unbracket, and drop one trailing dot.
 *
 * Applied to the pattern as well as the hostname so a hand-written `hosts` entry of
 * `[::1]` or `LocalHost` behaves the way whoever typed it expected.
 *
 * The trailing dot is the FQDN root form: `localhost.` resolves to loopback exactly as
 * `localhost` does, and browsers preserve it in `location.hostname`, so treating them as
 * different would deny a genuinely local page.
 */
function normalise(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '')
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

/** Three pattern kinds, chosen by the shape of the pattern itself. */
function matches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return matchesSuffix(host, pattern.slice(1))
  if (pattern.includes('/')) return matchesCidr(host, pattern)
  return host === pattern
}

/**
 * `*.local` → any hostname ending in `.local`.
 *
 * The leading dot on `suffix` is what makes this safe, and it is the entire reason this is
 * a named function rather than an inline `endsWith`. Matching on the bare suffix would let
 * `notlocal` through; matching without anchoring to a label boundary is how allow-lists
 * end up accepting `localhost.evil.com`. The bare suffix itself (`local`) is excluded
 * deliberately — `*.x` means a subdomain of `x`, not `x`.
 */
function matchesSuffix(host: string, suffix: string): boolean {
  return host.endsWith(suffix) && host.length > suffix.length
}

/**
 * `10.0.0.0/8` → any IPv4 address sharing its top 8 bits.
 *
 * IPv4 only. IPv6 ranges (`fc00::/7` unique-local, `fe80::/10` link-local) would need `::`
 * expansion, zone-ID stripping, and 128-bit prefix arithmetic for a case that has not come
 * up; deferred deliberately, and when it does come up it is a fourth arm here plus two list
 * entries, not a redesign. IPv6 addresses are matched exactly today, so `::1` is
 * recognised but its expanded `0:0:0:0:0:0:0:1` form is not — browsers normalise to the
 * short form, so only a hand-written config entry could hit that.
 */
function matchesCidr(host: string, pattern: string): boolean {
  const parts = pattern.split('/')
  const [network, bitsText] = parts
  if (parts.length !== 2 || network === undefined || bitsText === undefined) return false

  // Tested as text before `Number`, which is happy to turn '' and ' ' into 0. A malformed
  // `10.0.0.0/` would otherwise become a /0 — an entry matching every address on the
  // internet, arrived at by typo.
  if (!/^\d{1,2}$/.test(bitsText)) return false
  const bits = Number(bitsText)
  if (bits > 32) return false

  const hostBits = toIPv4(host)
  const networkBits = toIPv4(network)
  if (hostBits === undefined || networkBits === undefined) return false

  // /0 is special-cased because shifting a 32-bit value by 32 in JS is a no-op rather
  // than a zero — the mask would come out as 0xffffffff and match nothing but itself.
  if (bits === 0) return true

  // `>>> 0` throughout: `<<` and `&` yield *signed* 32-bit results, so anything with the
  // top bit set (127.0.0.0/8's mask, 192.168.x.x) compares as a negative number.
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (hostBits & mask) >>> 0 === (networkBits & mask) >>> 0
}

/**
 * A dotted quad as a 32-bit number, or `undefined` if it is not one.
 *
 * Strict on purpose. Leading zeros are rejected because `010.0.0.1` is octal in some
 * parsers and decimal in others, and an allow-list that disagrees with the resolver about
 * what an address means is a bug waiting to be found by someone else. Browsers normalise
 * IP literals in the URL, so a real `location.hostname` never carries one.
 */
function toIPv4(value: string): number | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined

  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    if (part.length > 1 && part.startsWith('0')) return undefined

    const octet = Number(part)
    if (octet > 255) return undefined

    result = result * 256 + octet
  }

  return result
}
