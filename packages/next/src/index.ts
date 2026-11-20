import { fileURLToPath } from 'node:url'

import {
  DEFAULT_ENDPOINT,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  findAppName,
  normaliseEndpoint,
  readConfigFile,
} from 'dogear-host'
import { CONFIG_FILE, findGitRoot, QUEUE_DIR } from 'dogear-queue'
import type { NextConfig } from 'next'
import type { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'

import type { LoaderOptions } from './loader.js'
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
   * `false` means no endpoint server, no rewrite and no loader, the same switch as
   * `dogear-vite`'s.
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
  /**
   * Stamp `data-dogear-src` onto host JSX elements in dev. Default `true`, for C1 (#15) and
   * J2 (#78).
   *
   * `false` keeps the endpoint: annotations still arrive, located by the selector floor (C3)
   * instead of an exact file and line. `enabled` is the switch for dogear as a whole. Layered
   * over `.dogear/config.json`, as under Vite.
   */
  readonly transform?: boolean
  /**
   * Which files the transform touches. Default `['**\/*.jsx', '**\/*.tsx']`. Relative patterns
   * resolve against the git root, as under Vite. Layered over `.dogear/config.json`.
   *
   * **Glob strings only**, where `dogear-vite` also takes a `RegExp`: Turbopack runs the loader
   * in a worker process, and what reaches it must be JSON. Only `.jsx` and `.tsx` files reach
   * the loader at all, which loses nothing, because Oxc parses no JSX in any other extension.
   */
  readonly include?: string | readonly string[]
  /**
   * Files the transform skips even when {@link DogearOptions.include} matches. Default
   * `['**\/node_modules/**']`; setting this replaces that rather than extending it. Layered
   * over `.dogear/config.json`.
   *
   * Dependencies are skipped regardless: the rules exclude `node_modules` before the loader
   * runs, so an `exclude` that leaves it out does not start stamping them.
   */
  readonly exclude?: string | readonly string[]
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

type Turbopack = NonNullable<NextConfig['turbopack']>
type TurbopackRules = NonNullable<Turbopack['rules']>
type RuleCollection = TurbopackRules[string]
type RuleEntry = Extract<RuleCollection, readonly unknown[]>[number]
type Webpack = NonNullable<NextConfig['webpack']>

/**
 * The built loader, beside this file in `dist/`. An absolute path, which both bundlers accept
 * as a loader name, so nothing depends on how the user's project resolves `dogear-next`.
 */
const LOADER = fileURLToPath(new URL('./loader.js', import.meta.url))

/**
 * The Turbopack globs the loader is registered under. Globs without a `/` match the file name,
 * so these two cover every directory. They are exactly the extensions Oxc parses as JSX, and
 * the loader's own filter narrows from there.
 */
const RULE_GLOBS = ['*.jsx', '*.tsx'] as const

/**
 * dogear's `next.config` wrapper. J1 (#77) decided it; J3 (#79) built its endpoint and J2 (#78)
 * its source stamping.
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

  const served: NextConfig = {
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

  // J2 (#78). Under the same preconditions as the endpoint, as under Vite: no git root means no
  // stamp, because a path relative to a repository dogear could not find is worse than none.
  if ((options.transform ?? file.transform) === false) return served

  const loader: LoaderOptions = {
    gitRoot,
    include: options.include ?? file.include ?? DEFAULT_INCLUDE,
    exclude: options.exclude ?? file.exclude ?? DEFAULT_EXCLUDE,
  }

  return {
    ...served,
    turbopack: withStampRules(config.turbopack, loader),
    webpack: withStampLoader(config.webpack, loader),
  }
}

/**
 * Register the loader under Turbopack, keeping every rule the user wrote.
 *
 * Each rule carries `condition: { not: 'foreign' }`, Turbopack's built-in for `node_modules`
 * and Next's internals, so the worker is never asked about a dependency. It sets no `as`: J1's
 * spike found `as` renames the module (`probe.tsx` became `probe.tsx.tsx`), and this loader's
 * output keeps its file type.
 *
 * **Ours goes first when the user already has a rule at the same glob.** Turbopack runs every
 * matching rule in order, and the stamp's line and column must describe the file as written,
 * not what another loader made of it. A shorthand list of loaders is one rule, so it is wrapped
 * as one rather than spread into separate rules.
 */
function withStampRules(
  turbopack: NextConfig['turbopack'],
  options: LoaderOptions,
): Turbopack {
  const ours: RuleEntry = {
    loaders: [{ loader: LOADER, options: loaderOptions(options) }],
    condition: { not: 'foreign' },
  }
  const rules: TurbopackRules = { ...turbopack?.rules }

  for (const glob of RULE_GLOBS) {
    const existing = rules[glob]
    rules[glob] = existing === undefined ? ours : [ours, ...asRuleList(existing)]
  }

  return { ...turbopack, rules }
}

/**
 * A user's collection as a list of rules. An object is one rule; a list made only of loaders
 * is the shorthand for one rule; any other list is already a list of rules.
 */
function asRuleList(collection: RuleCollection): RuleEntry[] {
  if (!Array.isArray(collection)) return [collection as RuleEntry]

  const entries = collection as readonly RuleEntry[]
  const isLoader = (entry: RuleEntry) => typeof entry === 'string' || 'loader' in entry
  if (entries.every(isLoader)) {
    return [{ loaders: entries as Extract<RuleEntry, { loader: string } | string>[] }]
  }
  return [...entries]
}

/**
 * Register the loader under webpack, after whatever the user's own `webpack()` does.
 *
 * **`enforce: 'pre'`** is the same word as under Vite and does the same job: pre loaders run
 * before Next's own `next-swc-loader`, so this one sees JSX rather than compiled `jsx()` calls.
 * The rule sits at the top level of `module.rules`, so it applies to every compilation webpack
 * runs for a page (`rsc`, `ssr` and the browser's). J1's spike found the loader runs once per
 * layer, and the stamps agree across them because the transform is deterministic, which is
 * what keeps hydration from reporting a mismatch.
 */
function withStampLoader(user: NextConfig['webpack'], options: LoaderOptions): Webpack {
  return (config, context) => {
    const resolved = typeof user === 'function' ? user(config, context) : config

    resolved.module ??= {}
    resolved.module.rules ??= []
    resolved.module.rules.push({
      test: /\.(?:jsx|tsx)$/,
      exclude: /[\\/]node_modules[\\/]/,
      enforce: 'pre',
      use: [{ loader: LOADER, options: loaderOptions(options) }],
    })

    return resolved
  }
}

/**
 * Loader options in the shape Turbopack's types demand: a JSON object with mutable arrays.
 * A fresh copy per registration, so no bundler can mutate what the other was given.
 */
function loaderOptions(options: LoaderOptions): { [key: string]: string | string[] } {
  const list = (patterns: string | readonly string[]) =>
    typeof patterns === 'string' ? patterns : [...patterns]

  return {
    gitRoot: options.gitRoot,
    include: list(options.include),
    exclude: list(options.exclude),
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
