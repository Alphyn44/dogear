/**
 * What dogear's two hosts share. J1 (#77) decided it; J3 (#79) and J2 (#78) moved it.
 *
 * `dogear-vite` and `dogear-next` each inline this package with tsup's `noExternal`, the way
 * both inline `dogear-queue`, so no published artifact gains a dependency of its own. The
 * transform's parser and map library are the exception that proves it: both hosts list them
 * as runtime dependencies, so tsup leaves them external. Nothing here may import from `vite`
 * or `next`: a host-specific import would break the other host.
 *
 * Two modules are deliberately **not** exported here, for one reason: esbuild keeps an import
 * it cannot prove free of side effects, so whatever this index re-exports reaches every entry
 * that imports anything from it.
 *
 * - The transform is `dogear-host/stamp`. It imports `oxc-parser`, whose native binding
 *   `dogear-next`'s config wrapper must not load on every evaluation of `next.config`.
 * - The file filter is `dogear-host/filter`. It pulls in `picomatch`, which only `dogear-next`
 *   depends on, and which would otherwise be bundled into `dogear-vite`.
 *
 * The sentinel (J4) still lives in `dogear-vite`. J1's rule is that the first story needing a
 * module moves it.
 */

export { findAppName } from './app-name.js'
export { validateBatch } from './batch.js'
export type { ClientConfig, ClientDist, Modifier } from './client.js'
export {
  buildClientConfig,
  clientScriptSrc,
  CONFIG_PARAM,
  DEFAULT_MODIFIER,
  MODIFIERS,
  resolveCoreDist,
  UNBUILT_CORE_WARNING,
} from './client.js'
export type { FileConfig } from './config-file.js'
export { readConfigFile, RECOGNISED_KEYS } from './config-file.js'
export type { EndpointHandler, EndpointOptions } from './endpoint.js'
export {
  createEndpoint,
  DEFAULT_ENDPOINT,
  MAX_BODY_BYTES,
  normaliseEndpoint,
} from './endpoint.js'
export { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from './patterns.js'
