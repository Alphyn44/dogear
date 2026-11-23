/**
 * The second half of `npm run build:fixtures`, added by J4 (#80): a production `next build`
 * of the leak fixture, for `scripts/gate/no-leaks.test.ts` to scan.
 *
 * A script rather than a bare `next build` in package.json for one reason: Next's telemetry is
 * network egress, and the flag that turns it off is an environment variable, which an npm script
 * cannot set the same way on Windows and on a POSIX shell. `.mjs`, not `.ts`, because Node's
 * floor here (20.19) cannot run TypeScript.
 *
 * Turbopack, Next 16's default, and only Turbopack: it is the bundler whose server maps embed
 * the app's source, which is the case the gate has to tell from a leak. Layer 1 is the phase
 * check, which runs before either bundler is configured.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'packages', 'next', 'test-built', 'fixtures', 'leak')
const next = join(
  dirname(createRequire(import.meta.url).resolve('next/package.json')),
  'dist',
  'bin',
  'next',
)

const result = spawnSync(process.execPath, [next, 'build', fixture], {
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
})

process.exit(result.status ?? 1)
