# @dogear/cli

The command-line half of [dogear](https://github.com/Alphyn44/dogear) — click an element
in your running app, leave a comment on it, and have your coding agent receive that
comment already bound to the exact source file and line.

This package sets a repository up, and then serves the queue to your agent over MCP.

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

Then follow the two lines `init` prints — `npm i -D @dogear/vite`, and a plugin entry in
your `vite.config`. That is the browser half; see
[`@dogear/vite`](https://www.npmjs.com/package/@dogear/vite).

## Commands

### `dogear init`

Sets this repository up. Non-interactive, idempotent, and safe to re-run — it diffs
against what is already there and reports only what changed. It:

1. **Finds the git root**, and refuses to run outside a repository. The queue location
   depends on it.
2. **Detects your setup** — Vite config, framework, workspace layout, how many apps, and
   which agent the repository shows signs of using.
3. **Wires that agent.** Every agent gets the MCP server registered — `.mcp.json`,
   `.cursor/mcp.json` or `.vscode/mcp.json` — plus an `AGENTS.md` stanza, since MCP is a
   pull surface and needs the nudge. Claude Code additionally gets a prompt hook merged
   into `.claude/settings.json` — merged, never clobbered.
4. **Writes `.dogear/config.json`** and creates `.dogear/`.
5. **Appends to `.gitignore`** — `.dogear/queue.json` and `.dogear/*.tmp`, not the whole
   directory, since the config is meant to be committed.
6. **Prints the plugin install and the `vite.config` change.** It writes neither: configs
   are too varied to rewrite safely, and a manifest edited without a lockfile update
   fails the next `npm ci`.

| Flag | |
| --- | --- |
| `--agent=claude\|cursor\|vscode\|none` | Wire this agent instead of the detected one |
| `--no-hook` | Skip Claude Code's prompt hook. The install still works — MCP carries everything |
| `--dry-run` | Print every change without writing any of them |
| `--undo` | Remove what init wrote to this repository, leaving your queue alone |

### `dogear hook`

Emits `UserPromptSubmit` JSON for Claude Code, so pending comments arrive with your next
message without your having to ask. **Your agent runs this, not you** — `dogear init`
wires it, and `--no-hook` declines it.

### `dogear mcp`

Runs the MCP server over stdio. This is the primary delivery path and carries dogear's
whole feature set; `dogear init` registers it, so you should not need to run it by hand.

| Tool | Input | Returns |
| --- | --- | --- |
| `dogear_pending` | `{ app?: string }` | `{ count, items }` — pending only, optionally filtered to one workspace package |
| `dogear_resolve` | `{ ids: string[] }` | `{ resolved, remaining }` |
| `dogear_prune` | `{}` | `{ pruned }` |

The server resolves its repository by walking up from `cwd` for `.git`, exactly as the
plugin does — so one repository has one queue however many dev servers are running.

### `dogear prune`

Drops resolved items from this repository's queue. The same operation `dogear_prune`
exposes, for when you would rather type it than ask.

### `dogear status`

What is running and what is pending, across every repository you have run `dogear init`
in. Reads `~/.dogear/projects.json` and each repository's queue; it never writes, and it
is the one command that does not refuse outside a git repository.

## Requirements

Node `^20.19.0 || >=22.12.0`.

Nothing dogear does leaves localhost. No telemetry, no analytics, no version check.

## License

MIT — see [LICENSE](./LICENSE).
