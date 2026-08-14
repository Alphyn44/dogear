import { createRequire } from 'node:module'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { TOOLS, callTool } from './tools.js'

/**
 * The MCP transport, and nothing else.
 *
 * Every line here is about speaking the protocol; every line about what dogear *does* is in
 * ./tools.ts, which imports no SDK at all. That is why the entire feature set is covered by
 * the fast suite and only the handshake needs a spawned process.
 *
 * **This file is loaded lazily**, by a dynamic `import()` in ./mcp.ts. `dogear hook` runs on
 * every prompt the user types, under a 10s timeout with a 2s budget asserted in
 * ../test-built/hook.test.ts — and it has no use for the SDK. Keeping the import here rather
 * than at the top of ./run.ts is what keeps the SDK out of the hook's startup path.
 *
 * **Three import subpaths, deliberately.** `server/index.js`, `server/stdio.js` and
 * `types.js`. Nothing from `server/streamableHttp.js` or `server/sse.js` enters the module
 * graph, so dogear's zero-network-egress rule holds by construction rather than by promise:
 * there is no code path here that can open a socket.
 *
 * **Nothing may write to stdout but the transport.** stdio MCP frames share the file
 * descriptor, so one stray `console.log` — a banner, a debug line, a trailing newline —
 * desynchronises the client's parser and the server appears to hang. Diagnostics go to
 * stderr, which MCP clients surface as server logs.
 */

/**
 * Read once at module load, with a fallback, because it is metadata rather than behaviour.
 *
 * `../package.json` resolves the same from `src/` and from `dist/` — both are one level
 * below the package root — so this works built or not. The same `createRequire` trick
 * `@dogear/vite` uses to locate core's bundle.
 */
const VERSION = readVersion()

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const { version } = require('../package.json') as { version?: unknown }
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Serve MCP over stdio until the client disconnects, then resolve with an exit code.
 *
 * `gitRoot` is resolved once by ./mcp.ts and held for the process's life — the *path* is
 * stable, and re-walking for `.git` on every call would be work for no answer. The queue's
 * *contents* are the opposite: every tool call re-reads the file, because a dev server may
 * have appended since the last one. Caching the queue at server start is the single mistake
 * `@dogear/queue`'s header exists to prevent.
 */
export async function serve(gitRoot: string): Promise<number> {
  const server = new Server(
    { name: 'dogear', version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const outcome = callTool(gitRoot, request.params.name, request.params.arguments)

    return {
      content: [{ type: 'text' as const, text: outcome.text }],
      // Omitted entirely on failure rather than sent empty. The declared `outputSchema`
      // requires its fields, so an empty object is a schema violation — and a client that
      // validates would report a malformed response instead of the error we are trying to
      // tell it about.
      ...(outcome.isError ? {} : { structuredContent: outcome.structured }),
      isError: outcome.isError,
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  return await new Promise<number>((resolve) => {
    // Resolve rather than reject, and 0 rather than non-zero: a client closing the pipe is
    // how an MCP session ends normally. Claude Code closes stdin on shutdown, and exiting
    // non-zero there would put a spurious failure in the user's logs on every quit.
    const finish = (): void => {
      resolve(0)
    }

    server.onclose = finish

    // **`StdioServerTransport` does not close itself when stdin ends.** It attaches only
    // `data` and `error` handlers, so an ended pipe fires nothing at all: `server.onclose`
    // never runs, this promise never settles, and node drains the event loop and exits
    // **13** — its code for an unresolved top-level await. That is the ordinary shutdown
    // path for every MCP client, so without this listener `dogear mcp` would report a
    // failure every time it was closed normally. Caught by the built suite's exit-code
    // assertion; nothing in a unit test can see it.
    process.stdin.once('end', () => {
      void server.close().finally(finish)
    })

    // A client that is killed rather than closed cleanly leaves the pipe open, so the
    // signals are the other way this ends. Closing the transport first lets the SDK flush
    // whatever it was mid-write on.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void server.close().finally(finish)
      })
    }
  })
}
