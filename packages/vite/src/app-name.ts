import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Finding the name of the workspace package this dev server serves — C4 (#18).
 *
 * The queue resolves from the git root, so a monorepo running three dev servers writes
 * three apps' annotations into one `queue.json`. `app` is what disambiguates them: when two
 * apps both have a `Button`, the agent needs to know which surface you were looking at.
 *
 * This walks from the *Vite* root, unlike ./git-root.ts which answers the opposite
 * question. That is the whole point of the pair — one repo, many packages.
 */

/**
 * The nearest `package.json`'s `name`, walking up from `startDir` and stopping at `gitRoot`.
 *
 * **The first `package.json` found wins, even when it has no `name`.** The nearest one *is*
 * the package the Vite root belongs to, so walking past it to a parent would not find a
 * better answer — it would confidently report a different package's name, which is worse
 * than reporting nothing in a field whose only job is to tell two packages apart.
 *
 * **The walk stops at `gitRoot`**, inclusive. The queue belongs to that repository, and a
 * repo nested inside another must not tag its annotations with the outer repo's package.
 *
 * **Nothing here throws.** An unreadable or malformed `package.json` returns `undefined`
 * like every other miss: a broken file somewhere above the Vite root is a real thing to
 * find in a working tree, and taking down someone's dev server over an optional tagging
 * field would be a wildly disproportionate response. The caller decides what `undefined`
 * means — as with {@link import('./git-root.js').findGitRoot}, this function does not guess
 * a fallback.
 */
export function findAppName(startDir: string, gitRoot: string): string | undefined {
  const stopAt = resolve(gitRoot)
  let current = resolve(startDir)

  for (;;) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) return nameIn(manifest)

    if (current === stopAt) return undefined

    // dirname('/') === '/' and dirname('C:\\') === 'C:\\', so the fixed point is the
    // filesystem root on both platforms. It is only reachable when `startDir` is not below
    // `gitRoot` at all — the check above ends the walk in every ordinary case — but without
    // it that mismatch would spin forever rather than returning nothing.
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** A trimmed, non-empty `name`, or `undefined` for every other outcome. */
function nameIn(manifestPath: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined

  const { name } = parsed as { name?: unknown }
  if (typeof name !== 'string') return undefined

  const trimmed = name.trim()
  return trimmed === '' ? undefined : trimmed
}
