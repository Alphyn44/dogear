import type { Plugin } from 'vite'

/**
 * dogear's Vite plugin.
 *
 * It does nothing yet. Script injection is A1, the endpoint is A2, and the JSX
 * attribute transform is C1. What is already here are the two flags that are far
 * easier to set correctly now than to retrofit:
 *
 * **`apply: 'serve'`** is the primary production defense, not a convenience. The
 * plugin does not exist during `vite build` at all, which covers the script injection
 * and the attribute transform with one line. Every other layer in the brief's
 * "Keeping it out of production" is a backstop behind this one.
 *
 * **`enforce: 'pre'`** is load-bearing for C1. Vite runs `pre` plugins before the
 * React plugin compiles JSX, so the eventual transform sees real JSX syntax rather
 * than already-compiled `jsx()` calls. Establishing it now means the ordering is a
 * decision rather than an accident of whoever writes the transform.
 *
 * Note there is no production/noop `exports` split here, unlike @dogear/core. This
 * package is a devDependency that is only ever imported by a Vite config, so it has
 * no path into an application bundle to defend.
 */
export function dogear(): Plugin {
  return {
    name: 'dogear',
    apply: 'serve',
    enforce: 'pre',
  }
}

export default dogear
