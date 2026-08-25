# dogear

Click an element in your running app, leave a comment on it, and have your coding agent
receive that comment already bound to the exact source file and line.

A Vite plugin, an overlay, and an MCP server. No extension, no IDE change, no account.
Nothing leaves localhost.

## Install

Once per machine:

```sh
npm i -g dogear-cli
```

Once per repository:

```sh
cd my-repo
dogear init
```

`dogear init` finds your git root, detects your setup, registers dogear's MCP server with
your agent, and prints the import and `plugins` entry your `vite.config` needs. Install the
plugin where your app lives, and `dogear-cli` at the git root:

```sh
npm i -D dogear-vite dogear-cli
```

```js
import { dogear } from 'dogear-vite'

export default defineConfig({
  plugins: [dogear()],
})
```

`dogear-cli` is installed twice on purpose. Globally, so `dogear` is on your PATH;
locally, because the MCP server and prompt-hook entries `init` writes are **committed** and
point at `node_modules/dogear-cli/dist/cli.js`, a repo-relative path, so that they resolve
for everyone who clones the repository rather than only on the machine that ran `init`.
Without the local copy the MCP server cannot start.

It is non-interactive and safe to re-run: it diffs against what is already there and
reports only what changed. `dogear init --dry-run` shows you every change without writing
any of them, and `dogear init --undo` takes them back out.

## The loop

1. Run `npm run dev` as normal.
2. Hold Alt. An outline follows the pointer. Click an element and a comment box opens on
   it.
3. Type the change: "shade darker", "move this two tabs right".
4. `⏎` queues it. A badge in the corner counts what is waiting. Point at the next thing;
   comments batch.
5. Click the badge to review the batch, where you can edit any comment, drop one, or add a note that
   applies to all of them, then submit with `⌘/Ctrl+⏎` or the button.
6. The batch lands in `.dogear/queue.json` at your git root. Your agent picks it up,
   edits, and marks the items resolved.

| Key | |
| --- | --- |
| `⏎` | queue the comment |
| `⇧⏎` | newline |
| `esc` | back out of one thing at a time; see below |
| `⌘/Ctrl+⏎` | submit the batch, with the review panel open |
| `Ctrl+Alt+P` | copy the batch to the clipboard instead. Works from anywhere |
| `Ctrl+Alt+D` | turn dogear off in this browser. Works from anywhere |

`esc` is a chain, most specific first: it cancels the batch note if you are editing it,
then a comment you are editing in the panel, then an open comment box, then the panel
itself. Each press undoes one layer, and dogear stops the event so your app does not also
close a modal on the same keypress.

`Ctrl+Alt+D` is remembered for that origin, so a reload stays off. The way back is
`__dogear.start()` in the browser console. The next page load prints that line for you, and
the Disable button's tooltip says it too. `__dogear` also carries `stop()` and a `running`
flag; `stop()` is this page only, while the chord is the stored preference.

Step 5 is deliberate rather than a formality: there is no way to submit without opening
the panel, so you always get a moment to review the batch and add a global instruction
before anything runs.

Each annotation carries the file and line dogear resolved for that element, plus a CSS
selector and a text snippet as a floor, so the agent can still find the code when the
line number has moved out from under it.

## Getting comments to the agent

Three ways, in order of preference:

- **MCP.** The primary path, and it carries the whole feature set. `dogear init`
  registers the server; your agent calls `dogear_pending` to read what is waiting,
  `dogear_resolve` to mark items done, and `dogear_prune` to drop the resolved ones.
- **A prompt hook.** Claude Code additionally gets `dogear hook` merged into
  `.claude/settings.json`, so pending comments arrive with your next message without your
  having to ask. `dogear init --no-hook` declines it and leaves a fully working install.
- **The clipboard.** `Ctrl+Alt+P` copies the batch in the same format the other two
  send. Works with no server, no agent integration, and nothing installed but the plugin.

The browser never talks to your agent. It writes a file; the agent reads it. Either half
can be broken, replaced, or driven by hand without the other noticing.

All three send the same block, so an agent nobody wrote an adapter for still gets
something it can act on:

```
<dogear-queue count="2">
[1] 01991b1e-4c2f-7c3a-9f5e-2b6d0a1c4e88 — src/components/Button.tsx:20  (Button, via attribute)
    app: web — http://localhost:5173/settings
    selector: main > form > button.primary
    text: "Save changes"
    note: keep the existing spacing scale
    comment: shade this darker on hover

[2] 01991b1e-51a7-7d10-8c44-9e3f7a20b6d1 — src/Sidebar.tsx:48  ⚠ stale
    selector: nav.sidebar > ul > li:nth-child(3)
    text: "Billing"
    comment: move this two tabs right
</dogear-queue>

These are annotations left by clicking elements in the running app. Each names where
the element was seen; treat the location as a strong hint, not a constraint — if it
does not match, locate the element by its selector or text instead.

Items marked ⚠ stale no longer have their text snippet in any file they name — the
line number is probably wrong; locate by selector or text instead.

When you have addressed an item, call dogear_resolve with its id.
```

The location is a hint on purpose. Between the click and the agent reading it, the file
may have been edited, so every annotation also carries a CSS selector and a text snippet,
and an item whose snippet has gone missing is marked `⚠ stale` rather than trusted. The
clipboard export closes with a different last line: its items never reached the queue, so
they have no ids and nothing to resolve.

## Packages

| Package | |
| --- | --- |
| [`dogear-cli`](https://www.npmjs.com/package/dogear-cli) | `dogear` on PATH: `init`, `hook`, `mcp`, `prune`, `status` |
| [`dogear-vite`](https://www.npmjs.com/package/dogear-vite) | The dev-only plugin. Stamps source attributes, injects the overlay, serves the endpoint |
| [`dogear-core`](https://www.npmjs.com/package/dogear-core) | The overlay itself. Framework-agnostic, and installed as a dependency of the plugin rather than directly |

A fourth workspace, `dogear-queue`, is private and never published. It holds the queue
format and is inlined into the three above at build time, so an install stays three
packages with no extra runtime dependency.

The flow is **browser → HTTP POST → `<git-root>/.dogear/queue.json` → MCP server →
agent**. The bridge is a file, never a socket, and one repository has one queue however
many dev servers are running against it.

## Not in production

The plugin declares `apply: 'serve'`, so it does not exist during a build, which covers
the injected script and the attribute transform together. Four further layers sit behind
it, including export conditions that resolve to a noop module, a CI check that fails on a
leaked sentinel string (a marker dogear plants in its own bundle so CI can prove none of it
reached a production build), and a runtime hostname bail. See
[the brief](./dogear-brief.md#keeping-it-out-of-production).

## Troubleshooting

dogear says what is wrong in the terminal your dev server is running in. Every line it
prints starts with `[dogear]`, so that is the first place to look.

**Nothing happens when I hold the modifier.** In rough order of likelihood:

- **The plugin is not in your `vite.config`.** Adding `dogear-vite` to `package.json` is
  half the wiring; the `plugins: [dogear()]` entry is the other half. `dogear init` prints
  the snippet and will keep printing it until both are true.
- **`[dogear] no .git found above …`.** The queue resolves from the git root, so dogear
  disables itself outside a repository rather than guessing. `git init`, or start the dev
  server from inside the repository.
- **`[dogear] disabled by …`.** Someone set `enabled: false`, either in `vite.config` or in
  `.dogear/config.json`. The message names which.
- **You are not on an allowed hostname.** This one is silent by design: a warning here
  would fire on a deployed page in front of real users. The default list covers localhost,
  the loopback range, `*.local` and the private IPv4 ranges, so a dev server reached through
  a public tunnel domain will not arm. Add the host to `hosts` in `.dogear/config.json`; the
  full default list is on
  [dogear-vite's page](https://www.npmjs.com/package/dogear-vite#hosts).
- **You pressed `Ctrl+Alt+D`.** It is remembered per origin, so a reload stays off. Run
  `__dogear.start()` in the console. If `__dogear` is undefined the overlay never loaded,
  which is one of the cases above rather than this one.
- **`[dogear] dogear-core has not been built`.** Only in a clone of this repository. The
  plugin serves core's built bundle, so `npm run build -w dogear-core -w dogear-vite`
  first, or use `npm run dev:example`, which does it for you.

**The MCP server will not start.** Almost always the local install: the entries `dogear
init` writes are committed and point at `node_modules/dogear-cli/dist/cli.js`, a
repo-relative path, so `npm i -D dogear-cli` has to have happened **at the git root** of
this repository, not in an app subdirectory. A global install alone puts `dogear` on your
PATH and leaves that path unresolvable. `dogear init` says so in a note when it wires an
agent and nothing in the repository provides that file. npm, pnpm and yarn all link a direct
dependency at the top level, so that path holds under each. The exception is Yarn's PnP
linker, which has no `node_modules` at all and cannot support a committed path like this
one.

**My comments are not reaching the agent.** Check `.dogear/queue.json` at your **git
root**, not your Vite root, which in a monorepo is a different directory. `dogear status`
lists every repository you have run `init` in, what is pending in each, and which dev
servers are live; it works from anywhere and never writes.

**I edited `.dogear/config.json` and nothing changed.** It is read once, at startup.
Restart the dev server. The `[dogear]` line naming the keys it picked up is the
confirmation that it did.

## Requirements

Node `^20.19.0 || >=22.12.0`, and Vite 8 for the plugin.

Firefox, Chrome and Edge. Firefox is the point: every comparable click-to-annotate tool is
a Chromium extension.

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

Two checks run in CI and sit outside `verify`, both deliberately — `verify` is what a release
gates on, and neither of these is a question about correctness that should be able to fail a
release:

```sh
npm run build && npm run test:packed   # install the real tarballs into a scratch project
actionlint                             # parse and lint .github/workflows/
```

`test:packed` is the one thing that exercises what npm *publishes* rather than what this
repository contains: everything else resolves the three packages through workspace symlinks,
so a tarball missing its `dist/` would pass all nine steps above. `actionlint` is a separate
binary rather than an npm dependency; [CONTRIBUTING.md](./CONTRIBUTING.md) has the version
and why shellcheck is worth having beside it.

The example app under [`examples/react-app`](./examples/react-app) consumes the **built**
plugin, and the plugin serves the overlay's **built** bundle, so both need building
before the example picks up a change:

```sh
npm run build -w dogear-core -w dogear-vite
npm run dev:example
```

`npm run dev:example` does both for you.

Architecture, data contracts, and a Decisions log explaining why each fork went the way it
did live in [`dogear-brief.md`](./dogear-brief.md).

## License

MIT. See [LICENSE](./LICENSE).
