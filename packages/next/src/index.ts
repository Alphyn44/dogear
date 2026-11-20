import {
  DEFAULT_ENDPOINT,
  findAppName,
  normaliseEndpoint,
  readConfigFile,
} from 'dogear-host'
import { CONFIG_FILE, findGitRoot, QUEUE_DIR } from 'dogear-queue'
import type { NextConfig } from 'next'
import type { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'

import { processState, startEndpointServer } from './server.js'

/**
 * Next's dev-server phase, compared by value.
 *
 * Typed against Next's own constant through a type-only import, so a rename in Next fails
 * `npm run typecheck`, while the wrapper loads nothing from `next` at runtime. A value import
 * would work too; this keeps the published file free of a CJS interop question for a single
 * string.
 */
const DEV_PHASE: typeof PHASE_DEVELOPMENT_SERVER = 'phase-development-server'

export interface DogearOptions {
  /**
   * Turn dogear off for this project entirely. Default `true`.
   *
   * `false` means no endpoint server and no rewrite, the same switch as `dogear-vite`'s.
   * `.dogear/config.json` layers underneath, and this option is checked first, so a disabled
   * project cannot be stopped by a dogear misconfiguration it will never use.
   */
  readonly enabled?: boolean
  /**
   * Base path for dogear's HTTP endpoints. Default `/__dogear`.
   *
   * Layered over `.dogear/config.json`, and validated by the same `normaliseEndpoint` as under
   * Vite: a same-origin path, no `//host`, no query, no fragment.
   */
  readonly endpoint?: string
  /**
   * What to record as the workspace package this server serves, for C4 (#18). Defaults to the
   * `name` from the nearest `package.json` above the directory `next dev` was started in.
   *
   * **Set this when you run `next dev <dir>` from outside the app.** Next gives a config no
   * way to learn its project directory, so dogear walks from `process.cwd()`. That is the app's
   * own directory under `npm run dev` and its kin, and some other directory otherwise. The git
   * root comes out the same either way; only this tag would name the wrong package.
   *
   * Not layered from `.dogear/config.json`, for the reason `dogear-vite` gives: that file is
   * per repo and this value is per app.
   */
  readonly app?: string
}

/** What Next passes a config function as its second argument. */
export interface NextConfigContext {
  readonly defaultConfig: NextConfig
}

/** A `next.config` default export in either of the forms Next accepts. */
export type NextConfigInput =
  | NextConfig
  | ((phase: string, context: NextConfigContext) => NextConfig | Promise<NextConfig>)

type Rewrites = NonNullable<NextConfig['rewrites']>
type Rewrite = { readonly source: string; readonly destination: string; basePath?: false }

/**
 * dogear's `next.config` wrapper. J1 (#77) decided it; J3 (#79) builds its endpoint.
 *
 * ```js
 * // next.config.mjs
 * import { withDogear } from 'dogear-next'
 * export default withDogear(nextConfig, options)
 * ```
 *
 * **The phase check is the primary production defense**, as `apply: 'serve'` is under Vite.
 * Outside `next dev` the user's config comes back exactly as it went in. It is equality with
 * the dev phase, never inequality with the build phase: `next start` evaluates the config too,
 * in `phase-production-server`, and a test for "not building" would wire the endpoint into a
 * production server.
 *
 * Returns a function of the phase, which is the form Next calls with `(phase, { defaultConfig })`.
 * A user config that is itself a function is called with the same two arguments first.
 */
export function withDogear(
  nextConfig: NextConfigInput = {},
  options: DogearOptions = {},
): (phase: string, context: NextConfigContext) => Promise<NextConfig> {
  return async (phase, context) => {
    const config =
      typeof nextConfig === 'function' ? await nextConfig(phase, context) : nextConfig

    if (phase !== DEV_PHASE) return config

    return attach(config, options)
  }
}

/**
 * Everything `withDogear` adds in the dev phase.
 *
 * The gates run in `dogear-vite`'s order, for its reasons: the `enabled: false` option before
 * anything can throw, the git root before the config file (which is found from it), and the
 * file's own `enabled: false` before the endpoint is validated. Every early return hands back
 * the user's config unchanged, so no gate can leave a rewrite pointing at a server that was
 * never started.
 */
async function attach(config: NextConfig, options: DogearOptions): Promise<NextConfig> {
  if (options.enabled === false) {
    say('log', '[dogear] disabled by config (`enabled: false`). No endpoint is served.')
    return config
  }

  const cwd = process.cwd()
  const gitRoot = findGitRoot(cwd)
  if (gitRoot === undefined) {
    say(
      'warn',
      `[dogear] no .git found above ${cwd}. dogear is disabled: the queue resolves from ` +
        'the git root, and there is no repository to resolve it from.',
    )
    return config
  }

  const file = readConfigFile(gitRoot, (message) => {
    say('warn', message)
  })

  if ((options.enabled ?? file.enabled) === false) {
    say(
      'log',
      `[dogear] disabled by ${QUEUE_DIR}/${CONFIG_FILE} (\`enabled: false\`). No endpoint ` +
        'is served.',
    )
    return config
  }

  // Throws on a bad option, as under Vite: the option is the author's own code. A bad value in
  // the file never reaches here, because `readConfigFile` drops it with a warning.
  const endpoint = normaliseEndpoint(
    options.endpoint ?? file.endpoint ?? DEFAULT_ENDPOINT,
  )
  const app = options.app?.trim() || findAppName(cwd, gitRoot)

  let port: number
  try {
    ;({ port } = await startEndpointServer({ gitRoot, endpoint, app }))
  } catch (error) {
    say(
      'warn',
      `[dogear] could not start the endpoint server, so dogear is disabled: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return config
  }

  say(
    'log',
    `[dogear] ready: ${endpoint} writes to ${QUEUE_DIR}/queue.json in ${gitRoot}.`,
  )

  return {
    ...config,
    rewrites: withEndpointRewrite(config.rewrites, {
      source: `${endpoint}/:path*`,
      destination: `http://127.0.0.1:${port}${endpoint}/:path*`,
      // The overlay POSTs to the endpoint as an absolute path, and the endpoint has no notion
      // of the app's `basePath`. Without this, a `basePath: '/docs'` app would only proxy
      // `/docs/__dogear/*`, and every submit would miss.
      basePath: false,
    }),
  }
}

/**
 * Put dogear's rule first in `beforeFiles`, keeping every rule the user wrote.
 *
 * `beforeFiles` because those run ahead of the filesystem and the app's own routes: a
 * catch-all page must not be able to answer `/__dogear/annotations` with HTML, which is the
 * Next form of the SPA-fallback trap `createEndpoint`'s header describes.
 *
 * A bare array is what Next treats as `afterFiles`, so it moves there rather than becoming
 * `beforeFiles` itself and changing when the user's rules run.
 */
function withEndpointRewrite(user: NextConfig['rewrites'], ours: Rewrite): Rewrites {
  return async () => {
    const resolved = typeof user === 'function' ? await user() : user

    if (resolved === undefined) return { beforeFiles: [ours] }
    if (Array.isArray(resolved)) return { beforeFiles: [ours], afterFiles: resolved }
    return { ...resolved, beforeFiles: [ours, ...(resolved.beforeFiles ?? [])] }
  }
}

/**
 * Print a `[dogear]` line once per process.
 *
 * Turbopack evaluates the config twice in one process, and every line here would otherwise
 * appear twice in the terminal, which reads like two servers.
 */
function say(level: 'log' | 'warn', message: string): void {
  const { said } = processState()
  if (said.has(message)) return
  said.add(message)
  console[level](message)
}

export default withDogear
