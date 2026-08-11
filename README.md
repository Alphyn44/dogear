# dogear

Click an element in your running app, leave a comment on it, and have your coding agent
receive that comment already bound to the exact source file and line.

A Vite plugin, an overlay, and an MCP server. No extension, no IDE change.

> **Status: pre-alpha.** The workspace is scaffolded; the product is not built yet. See
> [`dogear-brief.md`](./dogear-brief.md) for the design, and the
> [milestones](https://github.com/Alphyn44/dogear/milestones) for what is being worked on.

## Packages

| Package | Responsibility |
| --- | --- |
| `@dogear/core` | Overlay UI, source resolution, clipboard export. Framework-agnostic. |
| `@dogear/vite` | Dev-only plugin. Stamps source attributes, injects core, serves the endpoint. |
| `@dogear/cli` | `dogear` on PATH: `init`, `mcp`, `prune`, `status`. |

The flow is **browser → HTTP POST → `<git-root>/.dogear/queue.json` → MCP server → agent**.
The bridge is a file, never a socket, so either half can be tested or driven by hand
without the other.

## Development

Requires Node `^20.19.0 || >=22.12.0`.

```sh
npm install          # once, from the repo root
npm run verify       # format:check → build → typecheck → test
```

Individual steps:

```sh
npm run build          # build the three packages
npm run typecheck      # tsc --noEmit, per package
npm test               # vitest
npm run format         # prettier --write
```

The example app under [`examples/react-app`](./examples/react-app) consumes the **built**
`@dogear/vite`, so rebuild the plugin before the example picks up a change:

```sh
npm run build -w @dogear/vite
npm run dev:example
```

## License

MIT
