import { isAbsolute, posix, resolve } from 'node:path'

import picomatch from 'picomatch'

/**
 * Which files the transform touches, for a host that has no Vite to ask. J2 (#78).
 *
 * `dogear-vite` filters with Vite's `createFilter`, which is `@rollup/pluginutils`' function
 * inlined into Vite. `dogear-next` cannot import Vite, so this is a port of that function, and
 * "the files stamped are the ones the configuration includes, as under Vite" is held by
 * `packages/vite/src/filter-parity.test.ts`, which runs one table through both and requires
 * the same answers. The port was chosen over depending on `@rollup/pluginutils` for one
 * function, and over Node's `path.matchesGlob`, which is experimental on the Node 20 floor and
 * a different glob engine from the one Vite uses.
 *
 * **Strings only.** Vite's `FilterPattern` also admits `RegExp`, and a loader under Turbopack
 * runs in a worker process whose options must be JSON. `.dogear/config.json` could only ever
 * supply strings anyway.
 *
 * Exported as `dogear-host/filter`, not from the package index: `picomatch` is CommonJS, and a
 * re-export from the index would be bundled into `dogear-vite`, which never calls this.
 */

export type Patterns = string | readonly string[]

export interface FilterOptions {
  /**
   * Relative patterns resolve against this, as `createFilter`'s `resolve` option does. Both
   * hosts pass the git root, which is also what the stamped paths are relative to.
   */
  readonly resolve: string
}

/**
 * Compile `include` and `exclude` into a predicate over module paths.
 *
 * The rules are rollup's, in rollup's order: an id carrying `\0` is a virtual module and never
 * matches; `exclude` is checked before `include`; and an empty `include` means "everything not
 * excluded". Ids and patterns are compared with forward slashes, so a Windows path matches a
 * pattern written the portable way.
 *
 * Unlike rollup, each pattern is compiled **once**, here, rather than on every test. Rollup
 * recompiles inside the predicate, which is invisible under Vite and is not under a loader
 * that runs on every module of every layer.
 */
export function createFilter(
  include: Patterns | undefined,
  exclude: Patterns | undefined,
  options: FilterOptions,
): (id: string) => boolean {
  const compile = (pattern: string) =>
    picomatch(matcherString(pattern, options.resolve), { dot: true })

  const includes = asArray(include).map(compile)
  const excludes = asArray(exclude).map(compile)

  return (id) => {
    if (id.includes('\0')) return false

    const path = toForwardSlashes(id)
    if (excludes.some((matches) => matches(path))) return false
    if (includes.length === 0) return true
    return includes.some((matches) => matches(path))
  }
}

/**
 * Rollup's `getMatcherString`: absolute patterns and ones starting `**` are used as written;
 * anything else is joined onto the resolution base.
 *
 * The base is escaped first because it is a real directory spliced into a glob. A repository
 * at `C:\Code Projects (old)\app` would otherwise read its parentheses as an extglob and
 * match nothing.
 */
function matcherString(pattern: string, base: string): string {
  if (isAbsolute(pattern) || pattern.startsWith('**')) return toForwardSlashes(pattern)

  const escaped = toForwardSlashes(resolve(base)).replace(/[-^$*+?.()|[\]{}]/g, '\\$&')
  return posix.join(escaped, toForwardSlashes(pattern))
}

function asArray(patterns: Patterns | undefined): readonly string[] {
  if (patterns === undefined) return []
  return typeof patterns === 'string' ? [patterns] : patterns
}

function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}
