import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'

/**
 * Serving @dogear/core's dev bundle over the dev server.
 *
 * Split from ./endpoint.ts so that file keeps owning *routing*, which is its stated job, and
 * does not quietly grow into a static file server. The routing table lives there; the bytes
 * live here.
 *
 * Everything is read at request time rather than cached at server start. Same instinct as
 * the queue's read-modify-write rule: rebuilding core in a second terminal and reloading the
 * page has to work, and a bundle cached at startup would serve yesterday's overlay until the
 * dev server was restarted.
 */

/** The WHATWG-preferred form, and what Vite itself serves for JavaScript. */
const JAVASCRIPT = 'text/javascript; charset=utf-8'

/**
 * What the browser gets when @dogear/core has not been built.
 *
 * **A 200 with a working module, not a 5xx.** A non-200 on a module import surfaces in
 * DevTools as an opaque MIME or network error naming a URL the developer has never heard of;
 * a stub makes the import succeed and prints the exact command to run. It matches core's real
 * shape — `init` returning a callable teardown — so the injected tag's
 * `stop: init(...)` does not throw on the way past.
 *
 * It deliberately carries no sentinel: there is nothing here to leak and nothing to scan for.
 */
const MISSING_BUNDLE_STUB = `export function init() {
  console.warn(
    '[dogear] @dogear/core has not been built, so the overlay is not available. ' +
      'Run \`npm run build -w @dogear/core\` and reload.',
  )
  return () => {}
}
`

export function sendClientBundle(res: ServerResponse, bundlePath: string): void {
  send(res, readFileSync(bundlePath, 'utf8'), JAVASCRIPT)
}

/**
 * Served byte-identical to what tsup built, under the name the bundle asks for.
 *
 * `dist/index.js` ends with `//# sourceMappingURL=index.js.map`, so the browser requests
 * `<endpoint>/index.js.map` — a slightly odd public URL, and the price of never rewriting the
 * served bytes. The alternative (rewrite that one comment line and serve `client.js.map`)
 * reads better and adds a transform that has to stay correct as tsup's output changes.
 *
 * The map's `sources` are `../src/*.ts`, so DevTools labels core's files under `/src/`, next
 * to the app's own. Only the label is confusing: `sourcesContent` is embedded, so the content
 * shown is the real TypeScript.
 */
export function sendSourcemap(res: ServerResponse, sourcemapPath: string): void {
  send(res, readFileSync(sourcemapPath, 'utf8'), 'application/json; charset=utf-8')
}

export function sendMissingBundleStub(res: ServerResponse): void {
  send(res, MISSING_BUNDLE_STUB, JAVASCRIPT)
}

function send(res: ServerResponse, payload: string, contentType: string): void {
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', Buffer.byteLength(payload))
  // `no-store`, matching every other dogear response. The file changes whenever someone runs
  // `npm run build -w @dogear/core`, and a cached stale overlay is a confusing hour. Doing
  // better would mean an ETag off mtime — machinery for a 3 KB same-origin dev asset. The
  // real wins of serving it as a file rather than inlining it (no blob in every HTML
  // response, a working sourcemap, a readable tag in view-source) all survive without it.
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}
