import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * F1 layer 3, against a real resolver.
 *
 * `packages/core/src/index.test.ts` asserts the *shape* of the exports map by reading
 * package.json, which keeps `npm test` independent of `npm run build`. It cannot tell you
 * what Node actually does with that map. This can, and it is the difference that matters:
 * layer 3's whole claim is "a resolver that has never heard of dogear's `development`
 * condition gets an inert module", and only a resolver can settle it.
 *
 * `IS_NOOP` exists for exactly this. The assertion is behavioural — the module you *get* is
 * inert — rather than structural, because a filename comparison would still pass if the two
 * built files ever had their contents swapped.
 *
 * Runs under vitest.built.config.ts: it imports through `dist/`, so it needs a build.
 */

/**
 * The repo root, where `node_modules/@dogear/core` is the workspace symlink. Resolution of
 * a bare specifier is relative to the importing file, and for `node -e` that is `cwd`.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Import `@dogear/core` in a fresh Node process under an explicit condition set, and report
 * whether what came back was the noop.
 *
 * `--conditions` is the only honest way to test this. Vitest's own `resolve.conditions` is
 * Vite's resolver rather than Node's, and vitest.config.ts already pins `development` for
 * the fast suite — running this in-process would be asking the wrong resolver a question it
 * has already been told the answer to.
 */
function resolveIsNoop(conditions: readonly string[]): Promise<string> {
  const args = [
    ...conditions.map((condition) => `--conditions=${condition}`),
    '--input-type=module',
    '-e',
    "const m = await import('@dogear/core'); process.stdout.write(String(m.IS_NOOP))",
  ]

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { cwd: REPO_ROOT, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `resolving @dogear/core with [${conditions.join(', ')}] failed: ` +
                `${error.message}\n${stderr}`,
            ),
          )
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

describe("Node's resolution of @dogear/core (F1, layer 3)", () => {
  it.each([
    {
      why: 'Vite sets this during serve, and it is the only path to the live overlay',
      conditions: ['development'],
      isNoop: 'false',
    },
    {
      why: 'Vite sets this during build',
      conditions: ['production'],
      isNoop: 'true',
    },
    {
      why: 'plain Node names no condition, and must not fall through to the overlay',
      conditions: [],
      isNoop: 'true',
    },
    {
      why: 'an unrecognised condition must fail safe via `default`',
      conditions: ['wibble'],
      isNoop: 'true',
    },
    {
      why: 'a bundler naming several conditions dogear does not know still fails safe',
      conditions: ['wibble', 'browser', 'worklet'],
      isNoop: 'true',
    },
  ])('gives IS_NOOP=$isNoop for [$conditions] — $why', async ({ conditions, isNoop }) => {
    await expect(resolveIsNoop(conditions)).resolves.toBe(isNoop)
  })

  it('gives the live module ONLY for `development`', async () => {
    // The counterweight. Every other row asserts inertness, so a build in which both files
    // were the noop would satisfy all of them and prove nothing.
    await expect(resolveIsNoop(['development'])).resolves.toBe('false')
  })
})
