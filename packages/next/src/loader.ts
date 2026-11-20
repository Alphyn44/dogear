import { isAbsolute, resolve } from 'node:path'

import { createFilter } from 'dogear-host/filter'
import { stampSource } from 'dogear-host/stamp'

/**
 * dogear's loader for both of `next dev`'s bundlers — J2 (#78).
 *
 * J1 ruled that stamping attaches as one loader, registered by `withDogear` under both
 * `turbopack.rules` and `webpack()`. Both bundlers hand a loader the source as written, before
 * SWC compiles the JSX, which is what `enforce: 'pre'` buys under Vite; everything that decides
 * *what* to stamp is `stampSource`'s, shared with `dogear-vite` through `dogear-host`. This
 * module only decides whether to call it.
 *
 * **A separate tsup entry, `dist/loader.js`.** The config wrapper never imports it, so
 * evaluating `next.config` does not load Oxc's native binding; only a bundler that runs the
 * loader does.
 *
 * **Everything it needs arrives as loader options, and they are JSON.** Turbopack runs loaders
 * in a separate worker process (J1's spike), so nothing the config computed can be shared with
 * this module except through `this.getOptions()`. That is why the filter is compiled here, from
 * strings, rather than handed over as a function, and why `include` and `exclude` admit no
 * `RegExp` under Next.
 *
 * **It never breaks the page.** A thrown error passes the source through unchanged and is
 * reported once per process. The trade is the one every host makes: the developer came to work
 * on their app, and a dev tool failing must not take it down. A *parse* error never gets this
 * far, because `stampSource` returns `null` on one, silently, as it does under Vite.
 */

/**
 * What `withDogear` passes. Spelled out rather than borrowing `dogear-host`'s `Patterns`,
 * because tsc copies type imports into `dist/loader.d.ts` and that package is never published.
 */
export interface LoaderOptions {
  readonly gitRoot: string
  readonly include: string | readonly string[]
  readonly exclude: string | readonly string[]
}

/**
 * The part of the webpack loader API this module touches, declared structurally.
 *
 * Next ships webpack's types only under `next/dist/compiled`, which is not a public path, and
 * Turbopack implements a subset of the API anyway (its docs list what is missing). Naming just
 * these five keeps the loader honest about what it relies on.
 */
interface LoaderContext {
  readonly resourcePath: string
  readonly rootContext?: string
  getOptions(): unknown
  callback(error: Error | null, content?: string, map?: unknown): void
  emitWarning(warning: Error): void
}

/** Compiled filters, keyed by the options that produced them. One entry per config in practice. */
const filters = new Map<string, (id: string) => boolean>()

let warned = false

export default function dogearLoader(
  this: LoaderContext,
  source: string,
  map?: unknown,
): void {
  try {
    const options = readOptions(this.getOptions())
    const file = absolutePath(this.resourcePath, this.rootContext)

    if (!filterFor(options)(file)) {
      this.callback(null, source, map)
      return
    }

    const stamped = stampSource(source, file, options.gitRoot)
    if (stamped === null) {
      this.callback(null, source, map)
      return
    }

    // No incoming map to chain: this loader runs first, on the file as written, so the map it
    // returns is the first in the chain and SWC composes its own on top.
    this.callback(null, stamped.code, stamped.map)
  } catch (error) {
    if (!warned) {
      warned = true
      this.emitWarning(
        new Error(
          `[dogear] could not stamp ${this.resourcePath}, so it carries no source ` +
            `attribute; later files may not either. ${
              error instanceof Error ? error.message : String(error)
            }`,
        ),
      )
    }
    this.callback(null, source, map)
  }
}

/**
 * Check the options rather than trust them. They are `withDogear`'s own output, so a mismatch
 * means a version skew between the wrapper and this file, and that is reported through the
 * same catch as any other failure instead of stamping against an undefined root.
 */
function readOptions(raw: unknown): LoaderOptions {
  const options = raw as Partial<Record<keyof LoaderOptions, unknown>> | null
  if (
    typeof options?.gitRoot === 'string' &&
    isPatterns(options.include) &&
    isPatterns(options.exclude)
  ) {
    return options as LoaderOptions
  }
  throw new Error(`unexpected loader options ${JSON.stringify(raw)}`)
}

function isPatterns(value: unknown): value is string | readonly string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  )
}

function filterFor(options: LoaderOptions): (id: string) => boolean {
  const key = JSON.stringify(options)
  let filter = filters.get(key)
  if (filter === undefined) {
    filter = createFilter(options.include, options.exclude, { resolve: options.gitRoot })
    filters.set(key, filter)
  }
  return filter
}

/**
 * `resourcePath` is absolute under webpack. Resolved against the project root if it ever is
 * not, so the path in the attribute and the filter's answer cannot depend on which bundler ran.
 */
function absolutePath(path: string, root: string | undefined): string {
  return isAbsolute(path) ? path : resolve(root ?? process.cwd(), path)
}
