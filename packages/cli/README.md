# dogear-cli

The command-line half of [dogear](https://github.com/Alphyn44/dogear). Click an element in
your running app, leave a comment on it, and have your coding agent receive that comment
already bound to the exact source file and line.

This package sets a repository up, and then serves the queue to your agent over MCP.

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

Then follow what `init` prints: the plugin install for each app it found, and the import and
`plugins` entry your `vite.config` needs. Install `dogear-cli` at the git root too, with
`npm i -D dogear-cli`. The plugin is the browser half; see
[`dogear-vite`](https://www.npmjs.com/package/dogear-vite).

This package is installed **twice on purpose**: globally, so `dogear` is on your PATH, and
locally, because the MCP server and prompt-hook entries `init` writes are committed and
point at `node_modules/dogear-cli/dist/cli.js`. That path is repo-relative so it resolves
for everyone who clones the repository. An absolute path out of one machine's npm prefix
would be broken for everyone else. Without the local copy the MCP server cannot start.

## Commands

### `dogear init`

Sets this repository up. Non-interactive, idempotent, and safe to re-run: it diffs
against what is already there and reports only what changed. It:

1. **Finds the git root**, and refuses to run outside a repository. The queue location
   depends on it.
2. **Detects your setup.** Vite config, framework, workspace layout, how many apps, and
   which agent the repository shows signs of using.
3. **Wires that agent.** Every agent it wires gets the MCP server registered (`.mcp.json`,
   `.cursor/mcp.json` or `.vscode/mcp.json`), plus a short stanza in your agent rules
   file, since MCP is a pull surface and needs the nudge. The stanza goes in `AGENTS.md`,
   or in `CLAUDE.md` if you have one and no `AGENTS.md`: a stanza in a file your agent
   does not read is a stanza that does nothing. It is delimited by
   `<!-- dogear:start -->` and `<!-- dogear:end -->`, which is what makes re-running safe.
   Claude Code additionally gets a prompt hook merged into `.claude/settings.json`,
   merged, never clobbered.
4. **Writes `.dogear/config.json`** and creates `.dogear/`.
5. **Appends to `.gitignore`.** `.dogear/queue.json` and `.dogear/*.tmp`, not the whole
   directory, since the config is meant to be committed.
6. **Prints the plugin install and the `vite.config` change.** It writes neither: configs
   are too varied to rewrite safely, and a manifest edited without a lockfile update
   fails the next `npm ci`.

| Flag | |
| --- | --- |
| `--agent=claude\|cursor\|vscode\|none` | Wire this agent instead of the detected one. **Repeatable**: `--agent=claude --agent=cursor` wires both. `none` selects nothing and is not additive, so it clears anything named before it |
| `--no-hook` | Skip Claude Code's prompt hook. The install still works, since MCP carries everything |
| `--dry-run` | Print every change without writing any of them |
| `--undo` | Remove what init wrote to this repository. See [Uninstalling](#uninstalling); it is the one destructive thing here |

An argument it does not recognise is an error, not something ignored: a mistyped flag that
was quietly dropped would report `nothing changed` over a repository it never configured
the way you asked. `--undo` takes neither `--agent` nor `--no-hook`, because those choose
what to wire and undo removes all of it.

### `dogear hook`

Emits `UserPromptSubmit` JSON for Claude Code, so pending comments arrive with your next
message without your having to ask. **Your agent runs this, not you.** `dogear init`
wires it, and `--no-hook` declines it.

### `dogear mcp`

Runs the MCP server over stdio. This is the primary delivery path and carries dogear's
whole feature set; `dogear init` registers it, so you should not need to run it by hand.

| Tool | Input | Returns |
| --- | --- | --- |
| `dogear_pending` | `{ app?: string }` | `{ count, items }`, pending only, optionally filtered to one workspace package |
| `dogear_resolve` | `{ ids: string[] }` | `{ resolved, remaining }` |
| `dogear_prune` | `{}` | `{ pruned }` |

The server resolves its repository by walking up from `cwd` for `.git`, exactly as the
plugin does, so one repository has one queue however many dev servers are running.

### `dogear prune`

Drops resolved items from this repository's queue. The same operation `dogear_prune`
exposes, for when you would rather type it than ask.

### `dogear status`

What is running and what is pending, across every repository you have run `dogear init`
in. Reads `~/.dogear/projects.json` and each repository's queue; it never writes, and it
is the one command that does not refuse outside a git repository.

Set `DOGEAR_HOME` to move that registry off `~/.dogear`. It exists mostly so tests cannot
write to your real one. The only other environment variable dogear reads is
`CLAUDE_PROJECT_DIR`, which Claude Code sets when it spawns the prompt hook.

## Uninstalling

Run the undo **before** you uninstall the packages. It resolves paths by finding them, and
a `dogear` that is no longer on your PATH cannot take its own configuration back out.

```sh
dogear init --undo        # --dry-run works here too, and is worth a look first
npm uninstall dogear-vite dogear-cli
npm uninstall -g dogear-cli
```

`--undo` removes, in this order: Claude Code's prompt hook from `.claude/settings.json`;
the MCP entry from every one of `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json`; the
`<!-- dogear:start -->` stanza from `AGENTS.md` and `CLAUDE.md`; dogear's block from
`.gitignore`; `.dogear/config.json`; the `.dogear/` directory, if that left it empty; and
this repository's entry in `~/.dogear/projects.json`.

The hook comes out first on purpose. Everything else dogear leaves behind is inert (a stale
MCP entry costs one failed spawn per session), but an orphaned `UserPromptSubmit` entry runs
against a deleted path on **every prompt you type**, in a tool you believe you have removed.

Two things worth knowing before you run it:

- **`.dogear/config.json` is deleted even if you edited it by hand.** That is the one thing
  undo removes that you may have written. It is defensible only because the file is
  committed, since `.gitignore` deliberately does not cover it, so `git checkout` brings it
  back. Undo says on the way out which keys it destroyed rather than doing it silently.
- **`.dogear/queue.json` is never touched**, and `.dogear/` therefore stays if anything is
  still queued. Your annotations are yours; run `dogear prune` first if you want them gone.

It scans all three agent configs whatever your repository looks like now, rather than only
the agent it would detect today. Init with `--agent=cursor`, delete `.cursor/`, and a
detection-driven undo would walk straight past the entry it wrote.

Two things it cannot reach, both harmless: `~/.dogear/` itself stays if you have other
repositories registered, and a browser you pressed `Ctrl+Alt+D` in keeps
`localStorage['dogear:enabled'] = 'false'` for that origin.

## Requirements

Node `^20.19.0 || >=22.12.0`.

Nothing dogear does leaves localhost. No telemetry, no analytics, no version check.

## License

MIT. See [LICENSE](./LICENSE).
