# dogear

Click an element in your running app, leave a comment on it, and have your coding agent
receive that comment already bound to the exact source file and line.

A Vite plugin, an overlay, and an MCP server. No extension, no IDE change, no account.
Nothing leaves localhost.

## Install

Once per machine:

```sh
npm i -g @dogear/cli
```

Once per repository:

```sh
cd my-repo
dogear init
```

`dogear init` finds your git root, detects your setup, registers dogear's MCP server with
your agent, and prints the plugin install and the two-line `vite.config` change:

```sh
npm i -D @dogear/vite @dogear/cli
```

```js
import { dogear } from '@dogear/vite'

export default defineConfig({
  plugins: [dogear()],
})
```

`@dogear/cli` is installed twice on purpose. Globally, so `dogear` is on your PATH;
locally, because the MCP server and prompt-hook entries `init` writes are **committed** and
point at `node_modules/@dogear/cli/dist/cli.js` — a repo-relative path, so that they resolve
for everyone who clones the repository rather than only on the machine that ran `init`.
Without the local copy the MCP server cannot start.

It is non-interactive and safe to re-run — it diffs against what is already there and
reports only what changed. `dogear init --dry-run` shows you every change without writing
any of them, and `dogear init --undo` takes them back out.

## The loop

1. Run `npm run dev` as normal.
2. Hold Alt. An outline follows the pointer. Click an element and a comment box opens on
   it.
3. Type the change — "shade darker", "move this two tabs right".
4. `⏎` queues it. A badge in the corner counts what is waiting. Point at the next thing;
   comments batch.
5. Click the badge to review the batch — edit any comment, drop one, add a note that
   applies to all of them — and submit with `⌘/Ctrl+⏎` or the button.
6. The batch lands in `.dogear/queue.json` at your git root. Your agent picks it up,
   edits, and marks the items resolved.

| Key | |
| --- | --- |
| `⏎` | queue the comment |
| `⇧⏎` | newline |
| `esc` | cancel the comment, or close the review panel |
| `⌘/Ctrl+⏎` | submit the batch, with the review panel open |
| `Ctrl+Alt+P` | copy the batch to the clipboard instead — works from anywhere |
| `Ctrl+Alt+D` | turn dogear off in this browser — works from anywhere |

Step 5 is deliberate rather than a formality: there is no way to submit without opening
the panel, so you always get a moment to review the batch and add a global instruction
before anything runs.

Each annotation carries the file and line dogear resolved for that element, plus a CSS
selector and a text snippet as a floor — so the agent can still find the code when the
line number has moved out from under it.

## Getting comments to the agent

Three ways, in order of preference:

- **MCP** — the primary path, and it carries the whole feature set. `dogear init`
  registers the server; your agent calls `dogear_pending` to read what is waiting,
  `dogear_resolve` to mark items done, and `dogear_prune` to drop the resolved ones.
- **A prompt hook** — Claude Code additionally gets `dogear hook` merged into
  `.claude/settings.json`, so pending comments arrive with your next message without your
  having to ask. `dogear init --no-hook` declines it and leaves a fully working install.
- **The clipboard** — `Ctrl+Alt+P` copies the batch in the same format the other two
  send. Works with no server, no agent integration, and nothing installed but the plugin.

The browser never talks to your agent. It writes a file; the agent reads it. Either half
can be broken, replaced, or driven by hand without the other noticing.

## Packages

| Package | |
| --- | --- |
| [`@dogear/cli`](./packages/cli) | `dogear` on PATH: `init`, `hook`, `mcp`, `prune`, `status` |
| [`@dogear/vite`](./packages/vite) | The dev-only plugin. Stamps source attributes, injects the overlay, serves the endpoint |
| [`@dogear/core`](./packages/core) | The overlay itself. Framework-agnostic, and installed as a dependency of the plugin rather than directly |

The flow is **browser → HTTP POST → `<git-root>/.dogear/queue.json` → MCP server →
agent**. The bridge is a file, never a socket, and one repository has one queue however
many dev servers are running against it.

## Not in production

The plugin declares `apply: 'serve'`, so it does not exist during a build — that covers
the injected script and the attribute transform together. Four further layers sit behind
it, including export conditions that resolve to a noop module, a CI check that fails on a
leaked sentinel string, and a runtime hostname bail. See
[the brief](./dogear-brief.md#keeping-it-out-of-production).

## Requirements

Node `^20.19.0 || >=22.12.0`, and Vite 8 for the plugin.

Firefox, Chrome and Edge. Firefox is the point — it is what a browser extension cannot
give you.

## Development

```sh
npm install          # once, from the repo root
npm run verify       # the full gate
```

`verify` runs, in order: `format:check`, `typecheck`, `test`, `build`, `test:built`,
`typecheck:example`, `build:example`, `build:fixtures`, `check:leak`.

Individual steps:

```sh
npm run build          # the three published packages
npm run typecheck      # tsc --noEmit, per package
npm test               # vitest
npm run format         # prettier --write
```

The example app under [`examples/react-app`](./examples/react-app) consumes the **built**
plugin, and the plugin serves the overlay's **built** bundle — so both need building
before the example picks up a change:

```sh
npm run build -w @dogear/core -w @dogear/vite
npm run dev:example
```

`npm run dev:example` does both for you.

Architecture, data contracts, and a Decisions log explaining why each fork went the way it
did live in [`dogear-brief.md`](./dogear-brief.md).

## License

MIT — see [LICENSE](./LICENSE).
