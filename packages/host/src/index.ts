/**
 * What dogear's two hosts share. J1 (#77) decided it; J3 (#79) moved it.
 *
 * `dogear-vite` and `dogear-next` each inline this package with tsup's `noExternal`, the way
 * both inline `dogear-queue`, so no published artifact gains a dependency. Nothing in it may
 * import from `vite` or `next`: a host-specific import here would break the other host.
 *
 * The transform (J2) and the sentinel (J4) still live in `dogear-vite`. J1's rule is that the
 * first story needing a module moves it.
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
