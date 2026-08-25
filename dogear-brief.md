# dogear — project brief

> **Status:** source of truth for what is being built. Supersedes any earlier notes.
> Decisions here are settled unless this document says otherwise; open items are
> collected in [Still open](#still-open) and nowhere else.

---

## What dogear is

Click an element in your running app, leave a comment on it, and have your coding
agent receive that comment already bound to the exact source file and line.

- **Product name:** dogear (lowercase, everywhere — code, docs, UI strings)
- **Repository:** `dogear`
- **Packages:** `dogear-cli`, `dogear-core`, `dogear-vite`
- **License:** MIT

A personal project built in the open. Not a product, not a startup, no roadmap
obligations to anyone. That's a design constraint, not a disclaimer: it means the
ceremony stays low, the scope stays honest, and features exist because they get used
rather than because they demo well.

The packages publish **unscoped**: `dogear-cli`, `dogear-core`, `dogear-vite`. An earlier
draft of this section planned a free npm **organization** named `dogear`, with
`@<handle>/dogear-{cli,core,vite}` as the fallback if it were taken. It was taken — and
that fallback reintroduces the doubled name the organization existed to avoid, so G5 took
the other road. Unscoped keeps the install line short and removes `--access public` from
the release entirely, since only scoped packages default to restricted. (The bare `dogear`
name belongs to an unrelated hapi/statsd plugin last published in 2020.) See the Decisions
log.

---

## The problem

When working on a frontend with a coding agent, the hard part isn't describing *what*
to change — "move this two tabs to the right" is unambiguous. The hard part is
**localization**: telling the agent *which* element you mean. Today that means
grepping around yourself to find the component, or hoping the agent's search lands on
the right file.

Tools like v0 and Claude Design solve this by owning the whole environment: you click
a component and the model knows exactly what you're pointing at. dogear brings that
pointing gesture to a normal local dev setup, without changing IDEs or adopting a
different agent.

## Goal

**Point at a thing, say what's wrong with it, and have the agent already know where it
lives.** Zero copy-paste, zero grepping, zero "which Button did you mean?"

### Non-goals

Each of these is a plausible adjacent feature that would change the shape of the tool
if it crept in:

- **Not a design tool.** dogear captures *intent about* an element. It does not edit
  styles in the browser, generate CSS, or preview changes.
- **Not a plan or diff annotator.** That's a genuinely different problem — annotating
  what the agent *proposes* rather than what the app *renders*.
- **Not a production tool.** Every layer assumes localhost. See
  [Keeping it out of production](#keeping-it-out-of-production).
- **Not a code generator.** dogear never writes to your source files. It writes one
  JSON file; the agent does the editing.
- **Not a replacement for the agent's own search.** It's a strong hint, not a
  constraint. If the line number is stale, the agent should still find the right code
  from the selector and text snippet it also received.
- **Not a hosted service.** No account, no telemetry, no network egress beyond
  localhost.

---

## The loop

1. Run your backend and `npm run dev` as normal.
2. In any browser, modifier-click (⌥/Alt-click) an element. An overlay outlines it and
   opens a comment box.
3. Type the change: "shade darker," "move 4px right," "this needs to be two tabs over."
4. Repeat for as many elements as you want — comments batch into a queue.
5. Submit. The queue is written to disk.
6. In your agent, the pending comments arrive — on request via MCP, automatically if
   your agent supports a prompt hook, or by paste if all else fails. See
   [Delivery](#delivery-getting-the-queue-to-the-agent).
7. The agent edits, marks items resolved, page hot-reloads, rinse and repeat.

**Note step 6.** Hooks are reactive and cannot initiate a turn. The browser never
"sends to" the agent — it writes a file, and the agent picks it up.

This is a feature, not a workaround. You get a moment to review the batch and add a
global instruction before anything runs. It also means the browser half and the agent
half are never coupled: either can be broken, replaced, or driven by hand without the
other noticing.

---

## Prior art

The pointing gesture is solved several times over. **The loop is not.**

`react-grab` (npm package, script tag) hovers an element and puts source context on
your clipboard — the closest thing to dogear, and it stops at the clipboard: one
element, no comment, no batch, no disk. `drawbridge`, `wiebekaai/browser-annotations`,
and `OpenCode Chrome Annotation` are Chrome extensions doing variations on annotation
with a companion server or webhook. `stagewise` left this shape entirely.
`plannotator` annotates agent *plans and diffs* — adjacent, different input.

What none of them do is take you from *comment → batch → disk → agent* without a human
copy-pasting in the middle. You should be able to leave eight comments across three
pages, go make coffee, come back, type "go," and have the agent hold all eight.

That's the whole thesis. The rest of this document is greenfield — where prior art is
referenced below it's for a specific technical reason, not to position against anyone.

### Why a dev-server plugin rather than an extension

- **Chromium only** — no Firefox, which matters if you test across browsers.
- **Cannot write to disk** (sandboxed), so extensions need a companion local server or
  webhook anyway — two artifacts, two installs.
- **Content scripts run in an isolated world**, so reading framework internals means
  injecting into the MAIN world and messaging back. Fragile.
- **MV3 service workers get killed**; connections drop and need recovery logic.
- **An extension only sees a URL, not a process** — so it cannot tell which project
  `localhost:8000` belongs to. See
  [Multiple dev servers](#multiple-dev-servers-and-multiple-repos), where this turns
  out to matter a lot.

A dev-server plugin has none of these problems, because the dev server is already a
local process with filesystem access, same-origin with the page.

**Extensions do win on some things** — worth knowing, not worth chasing in v1: they
work on deployed/staging URLs, annotations survive reloads for free,
`chrome.tabs.captureVisibleTab` makes screenshots trivial, and nothing lands in
`package.json`.

---

## Architecture

Three packages, one monorepo (npm workspaces).

### `dogear-core`

Framework-agnostic. Knows nothing about Vite. Contains:

- Overlay UI: hover outline, modifier-click capture, comment box, queue display
- The source-resolution ladder
- Clipboard export (the universal fallback)
- POSTs JSON to a **configurable endpoint**

This is most of the code. Keeping it free of Vite assumptions is the one decision that
would be painful to retrofit — it's what lets a Chrome extension become a second
delivery mechanism later instead of a rewrite.

Core's only requirement of its host: *something* must serve the endpoint it POSTs to.
It does not care what.

### `dogear-vite`

Thin plugin. Three jobs:

```js
export default function dogear(options) {
  return {
    name: 'dogear',
    apply: 'serve',                 // never runs during build
    enforce: 'pre',                 // must see JSX before the react plugin compiles it
    transform(code, id) { /* stamp data-dogear-src on JSX elements */ },
    transformIndexHtml() { /* inject core */ },
    configureServer(server) { /* endpoint → writes .dogear/queue.json */ },
  }
}
```

Because the plugin injects the script itself, user source never imports the toolbar —
there's no reference that could survive into a production bundle.

`enforce: 'pre'` is load-bearing. Vite runs `pre` plugins before the React plugin's JSX
compilation, so our transform sees actual JSX syntax. Without it we'd be adding
attributes to already-compiled `jsx()` calls.

### `dogear-cli`

Installed globally, provides `dogear` on PATH. Subcommands:

| Command | Purpose |
|---|---|
| `dogear init` | Scaffold a repo: detect setup, write config, gitignore, wire the agent |
| `dogear mcp` | Run the MCP server over stdio |
| `dogear hook` | Emit `UserPromptSubmit` JSON for Claude Code |
| `dogear prune` | Drop resolved items |
| `dogear status` | What's running, what's pending, across all registered repos. The one command that runs outside a repo |

Absorbing the hook into the CLI removes a package that would otherwise exist to hold
about fifty lines.

### Delivery: getting the queue to the agent

**MCP is the product. Hooks are an upgrade you get where your tooling allows it.**

That ordering is deliberate. Building hook-first would mean a tool that works
beautifully in exactly one agent and not at all anywhere else, with the portable path
bolted on afterwards. Building MCP-first means dogear works everywhere on day one, and
the agents that support more get more.

**Baseline — the MCP server.** `dogear mcp` speaks MCP over stdio, so it works with
Claude Code, Codex, Cursor, Zed, and anything else that speaks the protocol. This is the
whole product: reading pending items, and — importantly — **resolving them**.

The critical property is `dogear_resolve`. The alternative is instructing the model to
hand-edit `.dogear/queue.json`, which is a reliable way to produce a malformed JSON
file. A tool call cannot corrupt the queue.

The one thing MCP cannot do is initiate. **MCP is pull** — the agent has to decide to
call the tool, so typing "go" surfaces nothing on its own. You say "check dogear" or
your rules file tells the agent to look. That's the baseline experience, and it is
perfectly usable.

**Upgrade — a prompt hook where the agent has one.** A `UserPromptSubmit` hook injects
pending items as `additionalContext` alongside whatever you typed, which is what makes
"type anything and it just happens" true. Same formatter, same queue, same resolve path
through MCP — the hook only removes the need to ask.

This is a genuine capability tier, not a fallback: if your agent supports hooks, dogear
gets meaningfully better, and if it doesn't, nothing is broken. Claude Code is currently
the only agent that can do it:

- **Codex CLI** has a `userpromptsubmit` hook, but it's behind a feature flag
  (`[features].codex_hooks`) and configured **globally** in `~/.codex/config.toml`
  rather than per project. Whether it can *inject* context or only observe and block
  is unconfirmed.
- **Cursor**'s `beforeSubmitPrompt` (3.11+) runs cloud-side and **cannot inject
  additional context** — there's an open feature request for exactly that.

Because MCP owns the formatting and the resolve path, the hook stays thin — it is a
trigger, not a second implementation. Any future agent that ships a context-injecting
prompt hook becomes a one-adapter addition rather than a redesign.

**Floor — the clipboard.** `Ctrl+Alt+P` in the overlay copies the formatted queue — the
batch the tab is holding, formatted by the same renderer the other two tiers use. No
server, no config, no protocol. Works with a web chat window, an agent nobody's written
an adapter for, or a colleague on Slack. Annoying by design — it's the thing that always
works, including when MCP is misconfigured.

Verified details of the Claude Code hook contract the implementation depends on:

- **Default timeout is 30s**, not the 600s that applies to most hook types. Ours
  completes in milliseconds; `timeout: 10` fails fast.
- **`UserPromptSubmit` does not support matchers.** Any `matcher` field is silently
  ignored — it always fires.
- **Exit 2 blocks *and erases* the user's prompt.** dogear must therefore **never exit
  2.** A missing or malformed queue exits 0 with no context.
- **Plain stdout is also injected as context** for this event. We still emit structured
  JSON so `suppressOutput` is available.
- **`CLAUDE_PROJECT_DIR`** is set, which locates the repo without depending on `cwd`.
- **Exec form cannot run `.cmd`/`.bat` shims** — and a global npm bin on Windows *is* a
  `.cmd` shim. So `dogear init` never writes `command: "dogear"`. It writes `node` plus
  a resolved path, preferring `${CLAUDE_PROJECT_DIR}/node_modules/...` when a local
  install exists so the config stays portable across machines:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ {
          "type": "command",
          "command": "node",
          "args": ["${CLAUDE_PROJECT_DIR}/node_modules/dogear-cli/dist/cli.js", "hook"],
          "timeout": 10
      } ] }
    ]
  }
}
```

### The bridge is a file, not a socket

The browser writes, the readers read. They never talk directly. Every half is
independently testable, and the state is inspectable with `cat` when something goes
wrong. This is also why the queue is JSON and not SQLite — the agent reads it, you
debug it, and neither should need a client.

### Multiple dev servers and multiple repos

You will have repo A serving `:8000`, `:8001`, `:8002` and repo B also wanting `:8000`.
Most of this is free, and the part that isn't has a specific fix.

**Free: cross-repo isolation.** The browser POSTs **same-origin**. The endpoint is
served by the very Vite process that served the page, and that process knows its own
root. The port never enters the routing decision, so two repos on `:8000` are simply
two processes with different roots. There is no shared namespace in which to collide.

This is worth stating plainly because **an extension cannot do this** — it sees a URL
and has to guess which project `localhost:8000` means. That guess is why every
extension-based tool needs a companion server with a registry.

**Not free: several dev servers inside one repo.** Three Vite roots, one git repo, one
agent session. Two rules:

1. **The queue resolves from the git root, not the Vite root.** Walk up for `.git`.
   One repo → one queue → one agent session. Resolving per-Vite-root would give a
   monorepo three queues and leave the hook guessing which to read.
2. **Every annotation records `origin` and `app`** — `http://localhost:8001` and the
   workspace package name. When two apps both have a `Button`, the agent needs to know
   which surface you were looking at.

**The concurrency bug this creates**, worth writing down before it bites: two Vite
processes appending to one file. The atomic temp filename must include the pid, and
the write must be read-modify-write — re-read the queue immediately before writing,
never cache it at server start. Otherwise app A's submit silently drops app B's items.

**Machine-level registry.** `~/.dogear/projects.json` records every repo dogear knows about
and the dev servers currently serving each one. It powers `dogear status` and is the piece a
future sidecar or extension mode would need, since those *do* have the URL-to-project problem.
Built by E5 (#30); `$DOGEAR_HOME` overrides the location.

**It has two writers, and they write different halves of an entry.** `dogear init` records
that a repo exists (install step 7 below); each plugin instance records its own dev server
once that server is *listening*. Neither is optional and neither is sufficient — see the
Decisions log for why the earlier "written by each plugin instance at startup" was wrong on
both counts.

Entries are keyed by a **normalised repo root**, not by origin: an entry has to exist before
any origin does, and one repo must not become two entries when two processes disagree about
a Windows drive letter's case. The origin→root direction a sidecar would want is a scan over
a handful of entries.

---

## Source resolution

**This is the hard part**, and it has two failure modes pulling in opposite directions.

### The `Button.tsx:12` vs `TabBar.tsx:42` problem

```jsx
// src/components/Button.tsx:12
export function Button({ label }) {
  return <button className="btn">{label}</button>   // ← the element literally lives here
}

// src/components/TabBar.tsx:42
<Button label="Save" />                              // ← but you probably meant here
```

You alt-click the Save button. Which line did you point at?

- *"Shade this darker"* → `Button.tsx:12`. You mean the button's own styling.
- *"Move this two tabs over"* → `TabBar.tsx:42`. You mean this instance's placement.

Both are correct. Which you want depends entirely on the comment you're about to type,
which the resolver cannot know. **So dogear doesn't choose — it sends the chain and
lets the agent pick**, using the comment as the disambiguator. That's why `sites` is an
array and not a field.

### The ladder

**1. `data-dogear-src` attribute — primary, v1.** The Vite plugin AST-transforms JSX in
dev and stamps `data-dogear-src="src/components/Button.tsx:12:5"` on each host element.
Core reads it with `closest()`.

- Synchronous and exact. No promises, no source maps, no framework internals.
- Immune to framework version changes. This is the layer that won't rot.
- Precise about host elements — which matters because React 19 removed `_debugSource`,
  so runtime approaches can no longer tell you which `<div>` you clicked, only which
  component created it.
- **Costs:** only exists where the transform ran. Third-party components, portals,
  `.js` files, and non-Vite setups have none. It pollutes the dev DOM, and each new
  framework (Vue SFC, Svelte) needs its own transform.

**2. CSS selector + text snippet — the floor, v1.** Always present, never fails, no
dependencies. A distinctive class or a string of visible text is frequently enough for
the agent to find the component on its own. **Layer 2 alone is already useful**, which
is why the overlay ships before any source resolution at all.

**3. Runtime fiber walk — deferred, not planned.** Where no attribute exists, a library
like [`element-source`](https://github.com/aidenybai/element-source) (MIT, wraps bippy)
can walk framework internals to recover a source location, covering React, Preact, Vue,
Svelte, and Solid at runtime with no build plugin. It also yields the *owner* site —
often exactly the `TabBar.tsx:42` answer the attribute can't give.

**We are not building this in v1, and possibly not at all.** Choosing the attribute
transform as the primary layer largely dissolves the need for it: in a Vite React app
with the transform on, everything in *your own code* already carries its source. Layer
3 only earns its keep for third-party components and portals — places you're less
likely to be leaving styling comments anyway.

The cost of taking it is real: `element-source` is v0.0.5, depends on `bippy@^0.5.x`
while bippy ships 0.6.1, is async, and its entire value rests on React internals its
own author warns about ("we don't recommend depending on internals unless you really,
*really* have to"). Declining it keeps dogear free of React-internals risk **entirely**,
which is a better property than the original draft claimed.

So: ship without it, use it for a week, and add it only if you actually alt-click
something with no attribute and get annoyed. It's an optional lazy-loaded dependency —
hours of work, not a rewrite. If it were ever abandoned, MIT permits vendoring, but
vendoring means owning a fiber-internals hack forever. That's the escape hatch, not the
plan.

Every resolved site carries a `via` field so the agent knows how much to trust it.

---

## Data contracts

### Annotation

```json
{
  "id": "0199c8f4-3a21-7c5e-b3d9-1f2a4c6e8b07",
  "status": "pending",
  "comment": "shade this darker, it's competing with the primary CTA",
  "createdAt": "2026-08-06T21:14:03.221Z",
  "resolvedAt": null,
  "origin": "http://localhost:8001",
  "app": "@acme/admin",
  "url": "http://localhost:8001/settings",
  "sites": [
    { "file": "src/components/Button.tsx", "line": 12, "column": 5,
      "tag": "button", "component": "Button", "via": "attribute" },
    { "file": "src/components/TabBar.tsx", "line": 42, "column": 7,
      "tag": "div", "component": "TabBar", "via": "attribute" }
  ],
  "element": {
    "tag": "button",
    "selector": "#settings > div.tab-bar > button:nth-of-type(2)",
    "text": "Save changes",
    "classes": ["btn", "btn-primary"],
    "id": null,
    "testId": "save-btn"
  },
  "viewport": { "w": 1512, "h": 945, "dpr": 2 }
}
```

- **`id`** — UUIDv7 (time-sortable, so the file reads chronologically without a sort).
- **`status`** — `"pending"` | `"resolved"`. Only `pending` reaches the agent. Staleness is
  *derived* at read time, not stored; see the Decisions log.
- **`origin` / `app`** — which dev server and which workspace package. Disambiguates a
  monorepo; see [Multiple dev servers](#multiple-dev-servers-and-multiple-repos).
- **`sites`** — nearest-first, **capped at 5**. May be empty; `element` never is.
- **`sites[].file`** — relative to the **git root**, forward slashes on every platform. The
  same root the queue resolves from, so an agent started anywhere in the repo can open the
  path unchanged. See the Decisions log.
- **`sites[].component`** — **optional.** Read from `data-dogear-component`, which the
  transform stamps only where the source wrote a name: the innermost enclosing binding
  starting with a capital, which is React's own rule for a component. Anonymous default
  exports and elements outside any component boundary carry no name, and the attribute is
  absent rather than empty. See the Decisions log.
- **`via`** — `"attribute"` | `"runtime"`.
- **`element.text`** — first 80 chars of `innerText`, trimmed. The re-anchoring lifeline.

### Queue file — `<git-root>/.dogear/queue.json`

```json
{
  "version": 1,
  "updatedAt": "2026-08-06T21:14:03.221Z",
  "items": [ /* annotations, oldest first */ ]
}
```

- **Resolved from the git root**, so one repo is one queue regardless of how many dev
  servers are running.
- **Append-with-status.** Submitting appends; nothing is ever silently dropped.
- **Written atomically** — serialize to `.dogear/queue.json.<pid>.tmp`, then `rename()`.
  A reader never observes a partial file. The pid matters: see the concurrency note.
- **Read-modify-write on every submit.** Never cache the queue in memory at server
  start — a second dev server may have written since.
- **`.dogear/queue.json` is gitignored;** `.dogear/config.json` is committed.

### POST body

```json
{
  "version": 1,
  "note": "these are all on the settings page",
  "batch": [ /* annotations, without status/resolvedAt — the server stamps those */ ]
}
```

`note` is optional — one instruction applying to the whole batch, typed in the review
panel. **The server stamps it onto every item in the batch** rather than storing it once
against the batch: the queue file has no batch grouping, and every operation downstream
of it is per-item (D2 resolves, D5 flags, D6 prunes), so a batch-scoped record would be
orphaned by the first resolve. It is stamped after the client's own fields and before the
four server-owned ones, so a batch note wins over a stray per-item `note` and still
cannot forge `id`/`status`/`createdAt`/`resolvedAt`.

Response: `{ "ok": true, "written": 3, "pending": 5, "queuePath": ".dogear/queue.json" }`

### HTTP endpoints

Served by `configureServer`, under a configurable base path (default `/__dogear`,
matching Vite's own `/__vite_ping` convention):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/__dogear/annotations` | Submit a batch |
| `GET` | `/__dogear/client.js` | `dogear-core`'s dev bundle — how the overlay reaches the browser |
| `GET` | `/__dogear/client.js.map` | Its sourcemap, under the name the bundle's own `sourceMappingURL` asks for |
| `GET` | `/__dogear/queue` | Current queue (overlay reads pending count) — **not built, and now in no story at all.** B5 found no caller for it: the POST response already returns `pending`, and the badge shows the local count. D4 was the last plausible claimant and turned it down — its clipboard copies the in-memory batch, since "works with no server" is one of its acceptance criteria. E5 was the last story that could have wanted it and **declined**: `dogear status` reads each repo's `queue.json` off disk, which works for the stopped dev servers this endpoint could never answer for. Nothing is left to claim it |
| `POST` | `/__dogear/prune` | Drop resolved items — **not built.** D6 shipped prune on the CLI and MCP surfaces and deferred this one for want of a caller; see the Decisions log |

### MCP tools

Exposed by `dogear mcp`. The server resolves its repo by walking up from `cwd` for
`.git`, exactly as the plugin does.

| Tool | Input | Returns |
|---|---|---|
| `dogear_pending` | `{ app?: string }` | `{ count, items }` — pending only, optionally filtered to one workspace package |
| `dogear_resolve` | `{ ids: string[] }` | `{ resolved, remaining }` |
| `dogear_prune` | `{}` | `{ pruned }` |

The `Returns` column is the tool's **structured** output. Each tool also returns a text
block, and for `dogear_pending` that text is the shared formatter's `<dogear-queue>` block
verbatim — the two are the same answer in two registers, which is what lets the same
rendering reach the hook, the server, and the clipboard. `app` is matched **exactly**, and
an item carrying no `app` is excluded when a filter is given.

Counts, since the names alone are ambiguous: **`resolved` is how many items the call
actually changed from `pending` to `resolved`**, not how many ids were passed — an unknown,
duplicated, or already-resolved id contributes nothing, which is what makes D2's no-op rule
observable. `remaining` and `pruned` are likewise counted after the write. Per-id detail
goes in the text block rather than in a fourth structured field.

### Agent-facing format

One formatter, shared by the hook, the MCP server, and the clipboard export:

```
<dogear-queue count="2">
[1] 01J8ZQK4 — src/components/Button.tsx:12  (Button, via attribute)
    also: src/components/TabBar.tsx:42  (TabBar, via attribute)
    app: @acme/admin — http://localhost:8001/settings
    selector: #settings > div.tab-bar > button:nth-of-type(2)
    text: "Save changes"
    comment: shade this darker, it's competing with the primary CTA

[2] 01J8ZQM1 — src/layouts/Sidebar.tsx:88  (Sidebar)  ⚠ stale
    app: @acme/admin — http://localhost:8001/billing
    selector: nav.sidebar > ul > li:nth-child(3)
    text: "Billing"
    comment: this needs to be two tabs over
</dogear-queue>

Items marked ⚠ stale no longer have their text snippet in any file they name — the
line number is probably wrong; locate by selector or text instead.

When you have addressed an item, call dogear_resolve with its id.
```

The stale sentence is emitted only when an item in the block actually carries the marker;
the resolve instruction is always there. Both sit below the block, in that order.

The clipboard variant closes with a different line instead of the resolve instruction:

```
These were pasted in rather than read from the queue, so there is nothing to resolve
when you are done.
```

Amended during D4 — the original wording was "…paste this to your agent", on the reasoning
that a pasting user has no MCP server. Both halves of that turned out to be wrong. The line
is read by the *agent*, not the user, and by then the pasting has already happened; and the
browser cannot know where a paste lands, which may well be a session with `dogear_resolve`
registered. What is true in every destination is the fact above: the clipboard renders the
browser's in-memory batch, which never reached `queue.json` and carries no ids, so nothing
there is resolvable regardless of tooling. See the Decisions log.

### Config

`<git-root>/.dogear/config.json`, committed, created by `dogear init`. Every key dogear
recognises, with the value each one falls back to:

```json
{
  "version": 1,
  "enabled": true,
  "modifier": "alt",
  "endpoint": "/__dogear",
  "transform": true,
  "include": ["**/*.tsx", "**/*.jsx"],
  "exclude": ["**/node_modules/**"],
  "hosts": [
    "localhost",
    "*.localhost",
    "127.0.0.0/8",
    "::1",
    "*.local",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16"
  ],
  "agent": "claude",
  "app": "web"
}
```

**That is the recognised set, not the file init writes.** `dogear init` writes
`{ "version": 1 }` and stops; every other key is absent until someone sets it, and an
absent key means "whatever dogear's current default is". Amended during E4 — see the
Decisions log.

`exclude` was added to the set during E7, which found it was a plugin option with no
config key: a file that can widen `include` but cannot adjust the skip list is a
half-configurable filter, and the commonest reason to touch `include` is also a reason
to touch `exclude`. Like `include`, setting it *replaces* the default rather than
extending it.

`agent` still has no reader — it is a `dogear init` concern, and E3 shipped the choice as
the `--agent` flag instead. Its value was corrected from `claude-code` to `claude` during
E7 to match the values that flag actually accepts (`claude|cursor|vscode|none`); nothing
reads the key either way, and giving it one needs its own story.

`app` has no reader either, and unlike `agent` it never will: this file is per *repository*
and `app` is per *Vite root*, which is the ambiguity C4 added the field to remove — a
monorepo's three dev servers cannot share one value for it. It is listed here because
`config-file.ts` recognises it, and it recognises it precisely so that a file carrying it is
**not** warned about as an unknown key. Recognised, documented, and deliberately inert.
Added to this block during G6, which found the code's recognised set and this list had
disagreed by one key since E7.

Plugin options override the file; the file overrides defaults. Machine-level prefs live
in `~/.dogear/config.json` and lose to both — still unbuilt, and out of E7's scope.
E4 (#29) writes the file; **E7 (#40)** gave it a reader in `dogear-vite`.

**A bad value in this file is warned about and dropped, never thrown on**, and that is
the opposite of how the same value behaves as a plugin option. See the Decisions log.

`enabled` is the repo-wide form of B6's kill switch, and it sits at the top of that same
precedence chain: `dogear({ enabled: false })` beats the file, which beats the default. It
is a **separate axis from B6's in-browser toggle**, which is per-origin and lives in
`localStorage` — a committed `"enabled": false` turns dogear off for everyone who clones
the repo, and no amount of clicking in one person's browser overrides it, because a
disabled plugin never injects the script at all. B6 ships the plugin option; E4 (#29)
wires the file underneath it.

`hosts` entries come in three shapes — an exact hostname, a `*.suffix` wildcard, or an
IPv4 CIDR range — and the list *replaces* the defaults rather than extending them. See
the Decisions log.

**C4's `app` is deliberately not a key here.** This file sits at the git root, one per
repo, while `app` describes a single Vite root — a monorepo's three dev servers would all
read the same key and tag their annotations identically, which is the ambiguity the field
exists to remove. It is a plugin option (`dogear({ app })`) layered over the `name` in the
nearest `package.json`, and that manifest *is* the per-package config layer.

---

## Install and init

Global once, then per repo — the model CodeGraph uses, for the same reason: the tool
is machine-level, the configuration is repo-level.

```
npm i -g dogear-cli                    # once per machine — `dogear` on PATH
cd my-repo && dogear init               # once per repo
npm i -D dogear-vite dogear-cli       # what init prints
```

**`dogear-cli` is installed twice, and the second one is not optional.** Everything step 3
writes — the MCP registration and the prompt hook alike — points at the repo-relative
`node_modules/dogear-cli/dist/cli.js`, because those files are committed and an absolute
path out of one machine's npm prefix is broken for everyone else who clones. So the global
install provides the command you type and the local one provides the path those configs
name. G3 (#44) found this by running the install path: without the local copy the MCP server
does not start and the prompt hook fails on every prompt, which is why `init` says so — see
the Decisions log.

`dogear init` is non-interactive and idempotent. It:

1. **Finds the git root.** Refuses to run outside a repo — the queue location depends
   on it.
2. **Detects the setup** — Vite config, framework, workspace layout, how many apps,
   and which agent the repo shows signs of using.
3. **Wires that agent.** Every agent gets the MCP server registered — `.mcp.json`,
   `.cursor/mcp.json` or `.vscode/mcp.json` — plus an `AGENTS.md` stanza, since MCP is
   pull and needs the nudge. Claude Code additionally gets the hook merged into
   `.claude/settings.json` (merged, never clobbered); `--no-hook` declines it and leaves
   a fully working install. `--agent=<name>` overrides detection. Amended during E3,
   which replaced "asks which agent you use" with detection plus flags — see the
   Decisions log.
4. **Writes `.dogear/config.json`** and creates `.dogear/`.
5. **Appends to `.gitignore`** — `.dogear/queue.json` and `.dogear/*.tmp`, not the whole
   directory, since config is meant to be committed.
6. **Prints the plugin install and the two-line `vite.config` change.** It writes neither.
   Config files are too varied to rewrite safely, and the manifest is printed rather than
   edited for reasons of its own — see the Decisions log. Amended during E8.
7. **Registers the repo** in `~/.dogear/projects.json` — that it *exists*, not any dev
   server, which init has no way to know about. Built by E5 (#30).

Re-running is safe: it diffs against what's there and only reports what changed.

`dogear init --dry-run` runs steps 1–2 and plans the rest, printing the detection result and
every change it *would* make without writing any of them. That is how step 2's report-before-
change is reachable from a non-interactive command; see the Decisions log.

`dogear init --undo` reverses steps 3–5 and 7 in *this* repo and reports what it removed,
taking the prompt hook out first. Step 2 does not run — detection describes a repo being set
up — and step 6 wrote nothing to reverse. `--dry-run` applies; `--agent` and `--no-hook` are
refused. Built by E6 (#39); see the Decisions log.

---

## Keeping it out of production

Layered, structural first:

1. **`apply: 'serve'`** — the plugin doesn't exist during build. Primary defense. Covers
   both the script injection *and* the attribute transform, so production DOM is
   untouched.
2. **Gated dynamic import** for non-Vite consumers:
   `if (import.meta.env.DEV) { import('dogear-core').then(m => m.init()) }`. Statically
   eliminated by bundlers. Dynamic import matters — a static one keeps the module in the
   graph.
3. **Export conditions** in `package.json` — `"production"` and `"default"` both resolve
   to a noop module. Unknown conditions fail safe.
4. **`devDependencies` + CI grep** for a sentinel string in `dist/`. Fails the build
   loudly if anything leaked.
5. **Runtime hostname check** — bail unless the page's hostname matches `hosts`, which
   defaults to loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), `*.local`, and
   the private IPv4 ranges. Last line only, and silent when it bails.

React strips fiber debug info in production builds so source resolution would fail
anyway, but the overlay and its key handlers would still be live. Don't rely on it.

---

## Features and user stories

Six epics. Each story is written to paste into an issue tracker without rewriting.

### Epic A — The pipe (M0)

*Prove browser → disk → agent end to end with a hardcoded payload, before any UI exists.*

**A1 — Dev-only injection**
As a developer, when I add the plugin and run `npm run dev`, a dogear script loads on my
page, so I know the toolbar is available without importing anything.
- The script is present in dev and absent from `npm run build` output.
- No entry appears in the user's source or import graph.
- A production build containing the sentinel string fails CI.

**A2 — Endpoint persists to disk**
As a developer, when anything POSTs a valid batch, it is persisted to
`<git-root>/.dogear/queue.json`, so the browser→disk half is provable with `curl` alone.
- A `curl` POST of a hardcoded batch creates the file with the correct shape.
- The path resolves to the git root, not the Vite root.
- The write is atomic; a reader never sees a partial file.
- Malformed JSON returns 400 and leaves the existing queue untouched.

**A3 — Minimal hook proves disk→agent**
As a developer, when I type any prompt in Claude Code, pending items appear in the
agent's context.
- Claude can restate the comment and file path from a hand-written queue file.
- Only `pending` items appear.
- The hook exits 0 in every case — missing, empty, or malformed queue included.
- *(Superseded by Epic D, which replaces this with the real three-tier delivery. M0's
  version is deliberately crude — it exists to de-risk path resolution and hook
  registration, which is where the interesting failures live.)*

**A4 — Empty queue costs nothing**
- No `additionalContext` is emitted; nothing appears in the transcript.
- Completes well under the 10s timeout.

### Epic B — Pointing (M1)

*The overlay. Useful on its own, with selector + text as the only localization.*

**B1 — Modifier-click captures an element**
- Alt-click outlines the element and opens a comment box anchored to it.
- The app's own click handler does not fire.
- Works in Firefox, Chrome, and Safari.

**B2 — Hover outline while the modifier is held**
- Holding Alt outlines the element under the cursor; releasing clears it.
- No layout shift, no scrollbars.

**B3 — Comment and queue**
- Typing a comment and pressing Enter adds it to an in-memory queue.
- A badge shows the pending count.
- Esc closes the box without queueing.

**B4 — Review before submit**
- The queue panel lists items with their comment and a short element label.
- Any item can be edited or deleted before submitting.

**B5 — Batch submit**
- Submitting POSTs all queued items and clears the local queue on success.
- A failed POST keeps the local queue intact and surfaces the error.
- The review panel carries an optional **note** — one instruction that applies to the
  whole batch — which is stamped onto every annotation in it and rendered by the shared
  formatter.

**B6 — Kill switch**
- A toggle and a keyboard shortcut disable dogear entirely; the preference persists
  across reloads.
- When disabled, listeners are **detached, not ignored** — real interaction testing
  behaves exactly as if dogear were absent.
- `dogear({ enabled: false })` has the same effect from config.

*(The toggle and the shortcut are **disable-only**. Nothing is attached while dogear is
off, so nothing in the page can switch it back on — re-enabling is `__dogear.start()` or
a reload. Disabling is unconditional and loses nothing: the queue is owned above the
session, so an unsent batch survives the cycle and comes back with it. See the Decisions
log.)*

**B7 — Overlay isolation**
- The overlay renders in a **closed** shadow root; no style crosses in either direction.
- Nothing it renders lives inside `<body>`, and its host tag is a name no app query asks for.
- **While idle and the queue is empty it has no nodes in the document at all** — the host is
  inserted when something becomes visible and removed when nothing is.

*(The second criterion originally read "it never appears in the user's own DOM queries or
snapshot tests". See the Decisions log — that claim was vacuous for component tests and
unachievable for browser tests, and it was amended during B7. The third gained its
"and the queue is empty" clause during B3, when the pending badge became the first thing
dogear renders that outlives a gesture — also in the Decisions log.)*

### Epic C — Localization (M2)

**C1 — Attribute transform**
- Host JSX elements in `include`d files carry `data-dogear-src="file:line:col"` in dev.
- Line and column refer to the **original source**, pre-compilation.
- The transform runs `enforce: 'pre'` and is absent from production builds.
- A spread (`<div {...props} />`) does not clobber the stamped attribute.

**C2 — Ancestor chain**
- Clicking yields `sites` ordered nearest-first, capped at 5.
- The chain spans component boundaries (both `Button.tsx` and `TabBar.tsx` appear).

**C3 — The floor always works**
- Every annotation carries a CSS selector and a text snippet regardless of framework,
  bundler, or resolution success.
- `sites` may be empty; `element` never is.

**C4 — Origin and app tagging**
- Every annotation records its `origin` and, in a workspace, its `app`.
- Two dev servers in one repo write to one queue without ambiguity.
- Concurrent submits from two servers lose nothing.

**C5 — Component names**
- Where available, each site carries the component's display name.

### Epic D — Delivery (M3)

**D1 — MCP server**
- `dogear mcp` exposes `dogear_pending`, `dogear_resolve`, `dogear_prune` over stdio.
- It resolves its repo from `cwd` by walking up for `.git`.
- `dogear_pending` accepts an optional `app` filter.
- Works in at least Claude Code and one other MCP client.

**D2 — Resolution without hand-editing**
- The agent marks items done by calling `dogear_resolve`, never by editing JSON.
- Resolved items stop appearing in subsequent prompts.
- A resolve of an unknown id is a no-op, not an error.

**D3 — Prompt hook as a capability upgrade** *(optional; ships only after D1–D2 work)*
- With the hook installed, typing "go" surfaces pending items with no explicit request.
- Without it, everything still works via MCP — the hook is additive and independently
  removable.
- The hook shares the MCP server's formatter and resolve path. It is a trigger, not a
  second implementation; no dogear behavior may exist only in the hook.

**D4 — Clipboard fallback**
- `Ctrl+Alt+P` copies the formatted queue to the clipboard.
- Works with no server, no MCP, and no agent configuration.
- Falls back to a hidden-textarea copy where `navigator.clipboard` is unavailable.

**D5 — Stale items are obvious and disposable** *(matcher amended during G3 — see the
Decisions log)*
- An item is marked `stale` when its text snippet appears in **none** of the files it
  names, compared whitespace- and case-insensitively. Amended during D5 — the original
  criterion said "its named file", literally, and flagged every healthy item; see the
  Decisions log.
- Stale items are still shown, flagged, with an instruction to locate by selector or text.
- The flag reaches the agent in both registers — the `⚠ stale` marker in the formatted
  block, and a derived `stale: true` on the item in `dogear_pending`'s structured output.
- Nothing is ever auto-deleted.

**D6 — Prune**
- `dogear prune` and `dogear_prune` remove resolved items and report the count.
- Always explicit — no TTL, no background sweep.

### Epic E — Install and init (M4)

**E1 — Global install, per-repo init**
- `npm i -g dogear-cli` puts `dogear` on PATH.
- `dogear init` refuses to run outside a git repo, with a message saying why.
- Re-running is idempotent and reports only what changed.

**E2 — Detection**
- init identifies Vite, the framework, and the workspace layout without being told.
- It reports what it found before changing anything.
- `dogear init --dry-run` reports the findings and every change it would make, and writes
  nothing. Added during E2 — see the Decisions log.

**E3 — Agent wiring**
- **Every agent gets the MCP server registered.** That is the baseline path and is never
  skipped. Claude Code, Cursor and VS Code, each through its own project-local config.
- init writes an `AGENTS.md` / rules stanza telling the agent to check pending
  annotations, since MCP is pull and needs the nudge.
- The prompt hook is offered only where the chosen agent supports one, and `--no-hook`
  declines it. Declining leaves a fully working install. Amended during E3 from "init
  then asks" — see the Decisions log.
- Claude Code's hook is merged into `.claude/settings.json` — existing hooks survive,
  and no line init did not write is reformatted.
- The hook is written as `node <path> hook`, never `dogear hook`, so it works on Windows.
- The path is repo-relative and portable whether or not `dogear-cli` is installed yet;
  a missing local install is reported, not worked around.

**E4 — Gitignore and config**
- `.dogear/queue.json` and `.dogear/*.tmp` are gitignored; `.dogear/config.json` is not.
- An existing `.gitignore` is appended to, never rewritten.
- init creates `.dogear/config.json`, holding `version` and nothing else. Amended during
  E4, which also split the reading half out into E7; see the Decisions log.

**E5 — Cross-repo status**
- `dogear status` lists registered repos, running dev servers, and pending counts.
- It works from anywhere, not just inside a repo. It is the **only** command that does not
  refuse outside one — every other walks up for `.git` and gives up.
- It never writes. A dead dev server's record is filtered out of the display and dropped by
  the *plugin* when that repo next starts one; a repo whose directory has gone is reported,
  not removed.
- No MCP tool answers this, which is a deliberate exception to "everything works through
  MCP" — see the Decisions log.

**E6 — Undoing an init**
- `dogear init --undo` removes what init added to *this* repo and reports what it removed.
  It refuses outside a git repo exactly as `dogear init` does, and `--dry-run` applies to it.
- The agent wiring comes out first and always: an orphaned `UserPromptSubmit` hook fires on
  every prompt against a path that no longer exists.
- Pending annotations are never destroyed silently — the queue is the user's data, and
  removing it is a separate, explicit act. `.dogear/` goes only once it is empty.
- Entries dogear did not write survive. A file is deleted only when it is byte-identical to
  what init writes; anything else is spliced. An edited `.gitignore` block is reported rather
  than guessed at. Added during E6 — see the Decisions log.
- `--agent` and `--no-hook` are refused alongside `--undo`, which unwires unconditionally.
  Added during E6; see the Decisions log.
- Uninstalling the CLI without running this is survivable: nothing dogear writes may break
  an agent that no longer has dogear installed.

**E7 — Config precedence**
- `dogear-vite` reads `<git-root>/.dogear/config.json` and layers it under its own plugin
  options: option, then file, then default. A key the file does not set is left to the
  default, not overwritten with one.
- `enabled`, `endpoint`, `modifier`, `transform`, `include` and `exclude` are all layered.
  `app` is not — it is per Vite root, and this file is per repo. `exclude` was added to the
  recognised set during E7; see the Config section.
- `hosts` reaches core's `isAllowedHost`, replacing the defaults rather than extending
  them. It is omitted from the wire entirely when the file does not set one.
- A config that will not parse is reported in the dev server's terminal and the plugin
  falls back to its options, rather than taking the dev server down. So is a key that
  parses but holds the wrong kind of value — see the Decisions log.

Split out of E4 during E4, which shipped the file without a reader. The four code comments
that named E4 for this work now name E7; see the Decisions log.

**E8 — Plugin install and the vite.config change**
- Where an app has no `dogear-vite`, init prints the dependency to install and the
  `vite.config` change to make. It writes neither.
- The install command matches the repository's package manager, and names the package the
  dependency belongs to — which in a monorepo is not always the app's own directory.
- An app that already declares the plugin **and calls it in its config** gets nothing. An app
  with only one of the two gets exactly the half it is missing. A repo with no Vite app gets
  nothing. Amended during G3 (#44) — see the Decisions log.
- `dogear-vite` in `dependencies` rather than `devDependencies` is reported, not moved.

Filed during E2, which found that install step 6 was in no story at all. Written as printing
rather than writing after the same ticket's grill; see the Decisions log.

`init` writes into four places outside `.dogear/` by the time E3 and E4 land — the agent's
config, an `AGENTS.md` stanza, `.gitignore`, and `~/.dogear/projects.json` — and
`npm rm -g dogear-cli` removes none of them. That asymmetry is the story: the install is
per-machine and the configuration is per-repo, so uninstalling the tool cannot clean up the
repos, and each repo has to be able to clean up after itself. The hook is the sharp edge
rather than a tidiness concern, because a `UserPromptSubmit` entry pointing at a deleted
binary fails on every prompt the user types.

### Epic F — Safety (cross-cutting)

**F1 — Nothing ships to production**
- All five layers in [Keeping it out of production](#keeping-it-out-of-production) are
  implemented and individually tested.

**F2 — CI catches leaks**
- A build containing the sentinel string fails loudly, naming the file.

**F3 — Runtime hostname bail**
- Core refuses to initialize on a non-local hostname even if every other layer failed.

### Epic G — Release (M5)

Everything above makes dogear work in *this* repository. This epic is what makes it
installable in someone else's, and none of it was tracked while the features were being
built — which is why it is filed as an epic rather than left as a release checklist.

**G1 — The repository reads as a product**
- `README.md` describes what dogear does, how to install it and how to use it, and no longer
  says the product is not built yet.
- An MIT `LICENSE` file exists at the root, matching the `license` field all three manifests
  already declare.
- Each published package carries its own `README.md`, because npm renders that file — and
  only that file — on the package page.

**G2 — The packages are publishable**
- `dogear-core`, `dogear-vite` and `dogear-cli` drop `private: true` and carry a real
  version. `dogear-queue` keeps both — it is source-only and inlined, and publishing it
  would add a runtime dependency the three-package install story does not have.
- `npm pack` on each produces a tarball containing `dist/` and no tests or fixtures.
- Nothing else about the manifests changes: `repository.directory`, `files` and `license`
  were written correctly when each package was created.

**G3 — The install path is exercised end to end, before anyone else runs it**
- A global install from a packed tarball puts `dogear` on PATH, and `dogear init` sets up a
  repository that was never part of this workspace.
- The plugin installs into that repository, its dev server serves the overlay, a click
  reaches `.dogear/queue.json`, and an agent reads it back through MCP.
- Verified on a repository dogear has never seen — a fresh Vite app, not `examples/react-app`,
  which resolves the workspace copies and therefore proves nothing about an install.

This was the one user journey nobody had run start to finish, and it is the first one a new
user hits. It was deliberately ordered before G4: a tarball can be installed locally, so
publishing is not a prerequisite for finding out whether the install works. Running it is
what found the two facts in G3's Decisions entries.

**G5 — The published names**
- The three packages publish as `dogear-cli`, `dogear-core` and `dogear-vite`, and
  `dogear-queue` keeps its `private: true`. The `dogear` organization was taken; see What
  dogear is, above.
- Nothing a user types changes but the package names: the binary is still `dogear`, the
  plugin is still `dogear()`, the MCP server is still registered under `dogear`, and the
  on-disk contract — `.dogear/`, `~/.dogear/`, the attributes, the sentinel — is untouched.
- The production-leak gate still names every package. Its rule was the prefix `@dogear/`,
  which is not expressible unscoped without colliding with `data-dogear-src`.

**G6 — The package pages say what the code does**
- The three READMEs agree with the code on what `dogear init` writes, what `--agent` and
  `--undo` do, and what an endpoint may be.
- `.dogear/config.json`'s keys are documented **in a published README**. They exist only in
  this document today, and this document is not in the tarball.
- A reader who cannot see the overlay has somewhere to look, and a reader who pressed
  `Ctrl+Alt+D` can find the way back.

**G4 — Publishing from CI, with provenance**
- A release publishes from GitHub Actions, and only the three packages. *Delivered against a
  tag trigger; #64 later moved that to a merge to `main` without changing what publishes.*
- Publishing uses OIDC trusted publishing — no stored credential, and provenance
  attestations emitted automatically. See Repo and publishing for why this is not optional.
- `npm i -g dogear-cli` from the public registry works on a machine that has never seen
  this repository.

G4 is last, and G5 and G6 are before it for the same reason: npm renders the README a
package carried *at publish time*, and a name cannot be corrected after someone has
installed it.

### Epic H — Testing (M6)

Every epic above tested the thing it built, and each did it well: the transform has fixtures,
the endpoint has a real server, the queue has a tolerance suite, `dogear init` has a built
binary spawned as a subprocess. What none of them could test is the *seams between* the
things they built — and every one of those seams is currently held by a person having checked
once.

Three of them, specifically. Every cross-package resolution in this repository goes through a
workspace symlink, so nothing has ever exercised the shape npm publishes. CI has only ever run
one operating system, and it is not the one dogear is developed on. And the product's central
claim — click an element, the comment arrives bound to a file and a line — has never been
verified end to end by anything but a click.

This epic is filed after the release rather than before it because the first release is what
turned each of these from a theoretical gap into an argument with evidence.

**H1 — Installing from a packed tarball, in CI**
- CI packs all three packages and installs the tarballs into a scratch project outside the
  workspace.
- The installed `dogear` binary runs, and `dogear init` sets that project up.
- The installed plugin resolves `dogear-core`'s bundle — the resolution a wrong `exports` map
  breaks.
- A package whose `files` array is missing `dist` fails this job.

The largest gap in the epic and the cheapest to close. A tarball that shipped no `dist` at all
would pass all nine steps of `npm run verify`, because every resolution lands in the source
tree where the build output already sits.

**H2 — CI on the platforms dogear is used on**
- The verify matrix runs on Windows and macOS as well as Linux.
- A path or casing regression that reproduces on only one platform fails a pull request there.
- The cost is bounded — the full Node matrix need not run on every platform.

Two pieces of code exist *because* of Windows, and both were reasoned out rather than observed
failing: `registryKey` upper-cases the drive letter, and everything `dogear init` writes points
at `node <path>` rather than `dogear`. Neither has been tested on Windows by anything but a
developer noticing.

**H3 — The browser round trip, tested**
- A headless browser loads a page served by a real dev server with the plugin loaded.
- It modifier-clicks an element, types a comment, queues it, opens the panel and submits.
- The annotation arrives in `.dogear/queue.json` with a `sites` entry naming a real file and
  line, `via: "attribute"` — not the selector floor.
- A transform regression that leaves the overlay working but the resolution wrong fails.

The last criterion is the story. A test asserting only that *an annotation arrived* would pass
on a build where the attribute transform had stopped running entirely, because the selector and
text floor would still produce an item.

**H4 — The workflow files are checked before a tag**
- A malformed workflow file fails a pull request.
- The check covers `ci.yml`, `verify.yml` and `release.yml`.
- It runs as part of `npm run verify`, or as a CI step a contributor can reproduce locally.

Nothing in `verify` parses YAML, so GitHub's own parser at push time is the only validator
these files have — and on the release path push time is *after* the tag exists. The
`.prettierignore` exclusion of `*.yml` is **not** what to undo here; that file states its own
reason, and formatting is not the problem. Validity is.

**H5 — A release rehearsal**
- `release.yml` can be run manually against a branch in a mode that publishes nothing.
- The dry run exercises the version comparison, the empty-tarball guard and the step summary,
  and reports what *would* publish.
- The mode cannot publish by accident.

The publish job is the least-exercised code in the repository, and under the old trigger its
first run was against a tag that already existed. What a rehearsal cannot cover is the OIDC
exchange itself, which is the part most likely to be misconfigured — this reduces the unknown
surface, it does not remove it.

**The rehearsal is `workflow_dispatch`, and the *event* is what makes it safe rather than an
input.** #64 split the workflow into an unprivileged `decide` and a privileged `publish`, so
gating `publish` on `github.event_name == 'push'` means a dispatched run never starts the job
that holds `id-token: write` and therefore never mints a token at all. An input gating the
publish *command* — H5's original shape, filed before the trigger moved — leaves the
credential present and rests on getting an `if:` right. An input can be set wrong; an event
cannot.

**H6 — The committed CLI path under pnpm and Yarn**
- The path `dogear init` writes is asserted to resolve after a real install under npm, pnpm and
  Yarn's `node-modules` linker.
- Yarn PnP is either supported or documented as unsupported, on the strength of a test rather
  than reasoning.
- A package manager whose layout breaks the path fails a pull request.

Everything init writes points at the repo-relative, committed
`node_modules/dogear-cli/dist/cli.js`, so it has to resolve under whatever package manager the
person cloning uses. That it does is currently reasoning, and the root README states it as
fact. Lowest priority in the epic: the failure is narrow, documented and unreported.

**Delivery ordering: H4, then H2, then H1.** H4 first because every other story here adds
workflow YAML and none of it is checked until it does. H2 before H1 so that H1's job inherits
the platforms rather than adding them again. H3 is the expensive one and independent of all of
them; H5 waits on the publish trigger being settled; H6 builds directly on H1's pack-and-install
harness.

### Non-functional requirements

- **Browsers:** Firefox, Chrome, Edge. Firefox is the point — it's what an extension
  can't give you. **Safari is intended and not yet verified** — B8 (#35) is the story, and
  until it closes the README claims the three above and not Safari. Corrected during G1,
  which would otherwise have shipped a user-facing browser list this one disagreed with.
- **Node:** `^20.19.0 || >=22.12.0`, matching Vite's own floor (Vite is at 8.2.1).
- **Overhead:** the transform must not make dev startup or HMR noticeably slower.
  Measure before optimizing; the budget is "unnoticeable," not a number.
- **Zero network egress.** Nothing leaves localhost, ever.

---

## Build order

Increasing order of how much can go wrong.

| | Milestone | Contains | Why here |
|---|---|---|---|
| **M0** | Prove the pipe | scaffold, A1–A4 | Path resolution, hook registration, and JSON shape are where the interesting failures live. Debug them with a **hardcoded** payload and an `alert('loaded')` script — no UI, no source resolution. M0 opens with the workspace scaffold — the npm workspaces root, the three package skeletons, and CI — because every story below it presumes a monorepo that no story creates. |
| **M1** | Overlay | B1–B7 | Modifier-click, hover outline, comment box, in-memory queue, POST on submit. Ships with selector + text only, and is **already useful** — an agent can often find a component from a distinctive class or text. |
| **M2** | Localization | C1–C5 | The attribute transform. Deterministic, synchronous, unit-testable against fixture files. |
| **M3** | Delivery | D1–D6 | MCP first (it owns the formatter and the resolve path), then the hook on top, then clipboard. Replaces M0's crude hook. |
| **M4** | Install and init | E1–E8 | Last because you hand-wire your own repo while building. This is what makes it usable in the *second* repo. |
| **M5** | Release | G1–G6 | After the features, because nothing here is worth doing twice. M4 makes dogear installable; this makes it *installed* — the packages were private and unpublished until this milestone, so `npm i -D dogear-vite` resolved to nothing and the install path M4 prints instructions for had never been run by anyone. |
| **M6** | Testing | H1–H6 | After the release, because the release is what turned each gap here from theoretical into evidenced. Every milestone above tested what it built; this one tests the seams *between* what they built — the published tarball, the operating systems, the browser round trip — each of which currently rests on a person having checked once. |
| — | Safety | F1–F4 | Cross-cutting; F1's `apply: 'serve'` layer lands in M0 with the plugin itself. |

Two deliberate orderings worth noting:

**The attribute transform comes before any fiber work** — and in fact the fiber work is
cut entirely (see the ladder). An earlier draft filed all source resolution last as "the
async, version-sensitive part." That's true of the *runtime* layer only. The transform
is a pure function from source text to source text — the most testable code in the
project.

**MCP comes before the hook**, not after. MCP owns the formatter and gives the agent a
safe `resolve` path; the hook is then a thin trigger over the same machinery. Building
the hook first would mean writing the formatter twice.

---

## Decisions log

**`dogear init` writes `{ "version": 1 }`, not the Config block. Settled during E4.**
The block above lists every key dogear recognises, and writing it out with today's values
was the obvious reading of "init writes `.dogear/config.json`". It is wrong in one
direction that only shows up later: a config file that restates a default *pins* it.
Change `DEFAULT_HOSTS` or the default modifier in a future release and every repo that
ever ran `dogear init` keeps the old value forever, having never expressed an opinion
about it. An absent key means "whatever dogear thinks", which is what a user who did not
edit the file actually wants, and it is also the only form under which "plugin option beats
file beats default" has three distinguishable layers. `version` is written because it is the
one key whose absence is genuinely ambiguous — E7's reader has to tell a config predating a
schema from a config that opted into every default.

**E4 shipped the config file without a reader; the precedence chain became E7.**
Four code comments assigned the reading half to E4 by name, and the issue's acceptance
criteria covered only the `.gitignore` split. Splitting on that seam keeps this ticket
inside `dogear-cli`, and keeps `hosts` — the one config key that feeds F3's runtime host
guard, a production-safety layer — out of a ticket about ignore rules. The cost is a
release where `.dogear/config.json` exists and nothing consumes it, which is visible and
harmless; the alternative was one ticket spanning three packages and touching the last
line of the production defense.

**A bad value in `.dogear/config.json` is warned about and dropped; the same value as a
plugin option still throws. Settled during E7.** `dogear({ modifier: 'banana' })` throws at
config time, and that stays right: `vite.config.ts` is the author's own code, in the file
they are editing, and a typo should be named loudly in the terminal in front of them. The
config file is a different artifact with a different audience — it is *committed*, so
whoever broke it is often not whoever is running the dev server, and one person's typo must
not stop everyone else's `npm run dev`. It is also user data that `dogear init` deliberately
never validates on the way in, so this reader is the first thing that will ever tell anyone
their config is wrong; the useful thing for it to do is say so and carry on.

Dropping rather than repairing is the other half. A rejected key is simply absent, so the
`??` chain falls through to the plugin option or the default exactly as if it had never been
written — which is what keeps "an unset key falls to the default rather than being
overwritten with one" true for broken keys as well as missing ones. Guessing what a value
was meant to be would make the precedence chain unpredictable in the one case where someone
is already confused.

The endpoint is the exception that proves the shape: it is validated by *calling*
`normaliseEndpoint` inside a `try`, not by restating its rules. An earlier draft accepted any
non-empty string, and `"endpoint": "/"` then threw out of the plugin a few lines later —
a dev server killed by a data file, which is the failure this whole rule exists to prevent.
`packages/vite/src/index.test.ts` found it rather than predicting it.

**`hosts` is omitted from the wire when the config file does not set one. Settled during
E7.** The plugin could resolve `hosts` to `DEFAULT_HOSTS` and always serialise the array;
instead the key is absent unless the file supplied it, and `dogear-core` applies its own
defaults. The reason is the one E4 already recorded for not writing defaults into the config
file: a restated default *pins* it. `dogear-vite` and `dogear-core` version independently,
so a plugin one release behind would keep overriding core's list with a stale copy on behalf
of a project that never expressed an opinion about it. Omission is the only form under which
the two halves can move separately.

It also keeps `[]` meaningful. An empty array has to survive the wire distinguishably from
absence, or "dogear runs nowhere" silently becomes "dogear runs on the defaults" — so `[]` is
honoured as itself, and `enabled: false` remains the clearer way to say the same thing.

Core resolves the list **all-or-nothing**, unlike every other field it resolves per-field: a
malformed array falls back to the defaults rather than to the strings inside it, because half
of a safety list is not a safety list and filtering would silently *widen* whatever the author
was narrowing. The per-entry dropping happens in `dogear-vite`, which reads the file in a
terminal and can name what it dropped. Core is silent, for F3's usual reason.

**`normaliseEndpoint` rejects protocol-relative paths, queries and fragments. Settled during
E7.** It already refused the site root; it accepted `//evil.com`, which is a protocol-relative
URL — and since F4 the endpoint is not only where the middleware mounts but the `src` of the
injected `<script>`, so a dev page would have fetched dogear's bundle from a third-party host.
That contradicts "zero network egress" outright. A `?` or `#` fails the other way round, by
colliding with the config parameter the same URL carries.

The hole predates E7 and was reachable only from `vite.config.ts`, which was never a trust
boundary — it is executable code loaded by the same process. E7 is what makes a *data file*
able to set the field, which is a new shape of the same problem, and the rule lives in the one
function every endpoint flows through so that both layers are covered by it.

**init asks git whether the queue is ignored; it does not read `.gitignore`. Settled
during E4.** "Is `.dogear/queue.json` ignored?" depends on `.git/info/exclude`, on the
user's `core.excludesFile`, on every `.gitignore` between the root and the file, and on
negation precedence that runs bottom-up within a file and top-down across them. Matching
lines would be a second, worse gitignore engine whose bugs surface as a queue quietly
getting committed — and it would append two redundant rules to any repo already using a
broader pattern, which is what dogear's own repository does. `git check-ignore` is
definitive and already installed. When it cannot answer at all — no git on `PATH`, a
worktree whose pointer went stale — init writes the rules anyway: a redundant line costs
nothing and an unignored queue gets committed. Idempotency in that degraded case rests on
a narrower check, "have I already written my own block?", which is not the same question.

**A step may report without changing. Settled during E4 by needing it twice.**
E1's `plan()` returned a `Change` or `undefined`, where a change is a past-tense line
printed after `apply()` returned. E4 found two things init must say and must not act on: a
`.gitignore` whose existing rules also swallow `config.json` — appending a negation repairs
a `.dogear/*` rule and silently fails against `.dogear/`, so it would fix the easy case and
lie about the hard one — and a `queue.json` already in git's index, where no ignore rule
has any effect and the fix is a `git rm --cached` only the user can decide to run. Neither
fits a `Change`, so `plan()` now returns `{ change?, notes? }`. E2's report-before-change
and E6's "a queue with pending annotations is reported, not deleted" want the same shape.

**Queue schema: overwrite vs. append-with-status → append-with-status.**
Claude marks items done, stale entries stay visible, history is inspectable. The costs —
filtering on read, and something must prune — are real but small and explicit. Overwrite
makes "mark this done" unrepresentable, which kills D2 and D5.

**Queue location: `<git-root>/.dogear/`, not `.claude/` and not the Vite root.**
Git root because one repo means one agent session, and a monorepo with three dev servers
must not produce three queues. A neutral directory rather than `.claude/` because the MCP
path means several different agents may read it. Queue gitignored, config committed.

**Queue format: JSON, not SQLite.**
CodeGraph needs SQLite because it indexes an entire codebase. dogear's queue is a handful
of objects that an agent reads and a human debugs. "You can `cat` it when something
breaks" is a design goal. SQLite would only earn its place if long-run cross-session
history became a feature, and it hasn't.

**Stale re-anchoring → don't. Make staleness visible instead.**
After an edit, `TabBar.tsx:42` may be line 47, and HMR often patches rather than
reloading. Chasing pins through refactors is a large problem with a small payoff at this
scale. Instead every item carries four independent anchors — file:line, CSS selector,
text snippet, component name — so a wrong line number is recoverable rather than fatal.
The reader flags an item stale when its snippet no longer appears in its file. It never
deletes.

**Staleness is derived at read time, never stored.**
An earlier draft listed `stale` as a third `status` value, which collided with two other
rules in this document: `status` decides what reaches the agent and only `pending` does,
while D5 requires stale items to be *shown*, flagged. Both cannot hold if `stale` is a
status. Deriving it resolves the collision in the direction the rest of the design already
points — staleness is a fact about the filesystem *right now*, recomputed by whoever reads
the queue, and a stored flag would go out of date the moment someone re-added the snippet.
So `status` is `pending | resolved`, and `⚠ stale` is a decoration the formatter computes
for an item that is still, in every other sense, pending. Settled during A3, when the
formatter that will eventually render the marker was written; free then because nothing
produced `stale`, and expensive once D5 has code assuming a stored value.

**Overlay isolation → what B7 can actually promise. Settled during B7 by discovering the
original criterion was false in both directions.**

"It never appears in the user's own DOM queries or snapshot tests" covers two scenarios and
does not survive either. A **component snapshot test** never sees dogear at all: the script
reaches a page only through the dev server's `transformIndexHtml`, a jsdom component test
loads no HTML document, and `dogear-core` is in nobody's import graph — A1 already
guaranteed this, so B7 was claiming credit for it. A **browser test driving the real dev
server** is the case where B7 earns its keep, and there "never appears" is unachievable:
anything rendered is a node, and `document.querySelectorAll('*')` finds it wherever it sits.

So the criterion is now three narrower claims that are all true and all useful. A **closed**
shadow root, so `host.shadowRoot` is `null` and nothing the app queries can reach in. The
host **outside `<body>`**, appended to `documentElement`, which defeats the probe that
actually matters — `document.body` serialization, what Testing Library and most snapshot
helpers use. And **zero nodes while idle**, which is what does most of the work: a test run
that never holds the modifier sees a document byte-identical to one dogear was never loaded
into, whatever it queries.

The host is `<dogear-overlay>` rather than `<div>` because `document.querySelectorAll('div')`
is a query real apps make. It is not a registered custom element — no upgrade, no lifecycle,
nothing in the registry to collide with, and an unknown element is `display: inline` exactly
like an unstyled div. The one risk taken is the placement: DOM insertion is not HTML parsing,
so the node stays a child of `<html>` and renders there, but it is off the beaten path. The
mount target is a single line in `overlay.ts` if a browser is ever found to mishandle it.

**Zero nodes while idle → narrowed to "and the queue is empty", by B3's pending badge.**

B7 flagged this as the one case that could weaken its third guarantee, and B3 is where it
came due. A badge that only appears while the modifier is held cannot tell you that you are
carrying eight comments, which is most of what a pending count is for — and batching across
several pages is the entire premise of B3. So the badge keeps the host mounted, and the
guarantee reads "zero nodes while idle **and the queue is empty**".

What the guarantee was written to protect is untouched. It exists so *a test run that never
touches dogear sees a document byte-identical to one dogear was never loaded into* — and a
non-empty queue can only exist because someone modifier-clicked and typed. The queue is
in-memory, so a reload empties it; there is no path by which a test that ignores dogear
inherits a mounted host. Teardown is unaffected and separately tested: `stop()` restores the
document byte-for-byte with a non-empty queue.

The rejected alternative was a timed flash — mount on queue, show the count, unmount a second
later. It buys a narrower word for "idle" at the price of a count that is knowable at some
moments and not others, which is worse than either honest option for someone trying to
remember what they have queued.

**Nothing is injected inline, because a strict CSP blocks it — F4.**
dogear used to bootstrap from an inline `<script>` that imported the served bundle and called
`init` with a config literal. A project serving `script-src 'self' 'nonce-…' 'strict-dynamic'`
in dev — increasingly common — blocks inline execution outright, so dogear did nothing and the
only symptom was a console error most developers would attribute to their own app. Found by
hand against an unrelated frontend; `examples/react-app` has no CSP, so nothing in M1 could
have caught it.

The tag is now `<script type="module" src="<endpoint>/client.js?config=…">` with no body. An
external same-origin script satisfies `'self'`, so no nonce is needed and dogear stays out of
the host application's CSP configuration entirely — better than reading Vite's nonce and
stamping it on the tag, which would couple dogear to every host framework's CSP plumbing.

Three consequences. **Config moves onto the URL**, as a single JSON parameter rather than one
per field, so the decoded object stays structurally identical to the plugin's and B5 adds
`endpoint` without touching the transport; core reads it from `import.meta.url`, since a
module script has `document.currentScript === null`. **Core gains a dev-client entry**, because
with nothing inline there is no caller — `index.ts` cannot self-start without becoming a
library that mounts an overlay when imported. **The sentinel keeps two carriers**: that entry
imports the constant directly, which `index.ts` may not.

**Client delivery → the plugin serves core's bundle; the inline tag is just the call.**
M0 inlined its whole payload in the `<script>`. The overlay is far too large for that: it
would be re-sent inside every HTML response, with no caching, no sourcemap, and a `</script>`
in the source silently ending the tag. Instead the plugin serves the built bundle at
`<endpoint>/client.js` and injects one inline module that imports `init` and calls it with a
JSON config literal.

The config crosses as a literal rather than a query string or a data attribute because a
module script has `document.currentScript === null` — the attribute route does not exist —
and a literal is the only form that stays typed on the plugin side. The sentinel is still
carried twice, in the tag attribute and the body, for the reason A1 gave.

The plugin reaches the bundle by resolving `dogear-core/package.json` and joining
`dist/index.js`. Resolving the package *name* from Node names no `development` condition and
lands on `dist/noop.js`, the inert build. A dedicated `./dev` subpath was rejected: it would
be a second live entry point any bundler could follow into a production graph, which is
precisely what layer 3 exists to close. A manifest is not code.

**No git root → no injection at all, not a disabled overlay.**
The endpoint was already skipped outside a repository, since the queue has nowhere to
resolve to. B1 extends that to the script tag. dogear that can point at elements and never
submit them is half a tool, and the failure mode is worse than absence: the injected
`client.js` import would be answered by Vite's SPA fallback with `index.html`, producing a
MIME-type module error naming a URL the developer has never seen — which reads like a dogear
bug rather than "you are not in a git repository". One warning in the terminal, nothing on
the page.

**`init()` returns its teardown, so B6's architecture lands with B1.**
"Detach, don't ignore" is a claim about *every* listener, which makes it structural rather
than a feature: one listener attached ad hoc falsifies it, and finding that one by audit is
exactly the retrofit B6 should not have to do. So B1 ships the registry — a single object
every listener goes through, with a source test failing any module outside it that calls
`addEventListener` — and `init()` returns the function that empties it. B6 adds a toggle, a
shortcut, and `localStorage` on top; it touches nothing below. dogear-vite exposes the
result as `window.__dogear.stop`, which makes the criterion provable by hand in a console a
milestone early.

**`modifier` is a plugin option now, with E4 layering the config file underneath.**
The plugin already has to serialise config into the injected `init(...)` call, so the
plumbing exists either way; adding the field costs one line and gives the config-passing path
a tested consumer instead of shipping it unexercised. The validation is deliberately
asymmetric: the *plugin* throws on an unknown modifier, at config time, in a terminal, where
a typo should be named — while *core* falls back to the default, because a dev tool that
throws during page load has broken the app it exists to help you inspect. Same value, two
audiences, two right answers.

**The browser has its own claim on the modifier key, and dogear only contests it while
visibly working.**
Alt is not a free key. On Windows, Firefox reveals its menu bar on the modifier's *keydown*,
while Chrome and Edge activate their menu or toolbar on the *keyup* — which is why cancelling
one and not the other suppresses Firefox and neither Chromium. Both are cancelled now, and
both only while dogear is actually outlining something. Cancelling unconditionally would take
the browser's own menu key away from the user for as long as the page had focus, which is not
dogear's to take; a lone Alt press on a page dogear is idle on still reaches the browser.

The same investigation removed a `window` blur listener that disarmed the overlay. It was
added to catch Alt+Tab delivering a keydown with no keyup, and it is the wrong trade here:
focus moving to browser chrome is a *direct consequence of the key dogear is bound to*, so the
outline could be raised and torn down in the same breath. Dropping it is nearly free, because
nothing load-bearing reads the armed flag — every suppression handler reads the modifier off
its own event, so a stuck flag cannot eat a click; the outline is cosmetic and the next
pointer or key event re-derives the state; and `visibilitychange` still covers a hidden tab.
Recorded honestly: the flash-and-vanish failure was **reasoned from the mechanism and never
reproduced**. Synthetic input over CDP goes straight to the renderer and bypasses browser
chrome, so no automated harness available here can raise it, and manual testing across Edge,
Chrome, and Firefox showed the outline appearing and staying. The listener is gone on the
argument, not on an observed defect.

**The batch note is stamped onto every item, not stored once against the batch — B5.**
The note was in the POST body from the first draft and in no story's acceptance criteria,
and `validateBatch` was quietly dropping it. Folded into B5, because the review panel it
has to live in is the one B5 builds.

Per-item duplication is the deliberate choice. The queue file is `{version, updatedAt,
items}` with no batch grouping, and adding one would be a schema change that every reader
— the hook, D1's MCP server, the CLI's parity test — has to learn. The stronger argument
is lifecycle: D2 resolves, D5 flags and D6 prunes **per item**, so a batch-scoped note is
orphaned the moment its last item is pruned, and an item that outlives its siblings loses
the instruction that explained it. Self-contained items are what append-with-status is
built on; the note has to be one of their fields or it is not durable.

The formatter renders it in the same ticket. A field that lands in `queue.json` and is
never rendered reaches no agent, which is the "everything works through MCP" rule failing
in its quietest form — and `format.ts` is shared by the hook, the MCP server and the
clipboard export, so teaching it once covers all three.

**A submit is confirmed by a badge that dismisses itself, so B7's guarantee stands
unamended.**
Clearing the queue on success leaves the panel with nothing to show, and something has to
say the write happened — `queue.json` is not on screen. Keeping the panel open with a
receipt was the informative option and it would have cost B7 its third criterion a second
time: nodes mounted, queue empty, no interaction in progress. So the panel closes and the
badge shows `3 sent` for a beat before reverting to the count and unmounting itself.

This is close enough to the timed flash rejected under "zero nodes while idle" to be worth
separating. That rejection was about the **pending count** — a number knowable at some
moments and not others is worse than either honest option, because you cannot check what
you are carrying. A submit confirmation is one-shot and answers a question that was asked
a moment ago by pressing a button; there is nothing to come back and re-read.

**A failed submit surfaces in the overlay and keeps every item.**
The local queue is the only copy, so it is cleared on a confirmed 200 and on nothing else.
Failure puts a normalised one-line reason in the panel footer with the queue intact and
Submit re-enabled, and the detail on `console.error` — the overlay row because "surfaces
the error" is otherwise only true with DevTools open, the console line because a 500 is a
server-side problem that needs more than one line. Pressing Submit again is the retry; a
backoff would be machinery for a localhost round trip.

The clear is keyed to the **item keys that were sent**, not to the queue as a whole.
Capturing an element closes the panel, so a modifier-click during an in-flight POST adds
an item that was never submitted — and clearing wholesale would delete it on success.
Keys already exist to stop exactly this class of mistake (see `QueueItem.key`).

**Kill switch → detach, don't ignore.**
An in-overlay toggle with a keyboard shortcut, persisted to `localStorage`, plus
`dogear({ enabled: false })`. Listeners are removed rather than early-returning — an
event handler that runs and decides to do nothing is still an event handler that ran.

**The kill switch is one-way in the page, because the alternative falsifies the rule —
B6.**

Detaching everything leaves nothing to switch dogear back on with: no listener can hear a
shortcut, and no node is on screen to click. The obvious fix is to keep one keydown
listener alive while disabled, and it is precisely the thing "detach, don't ignore"
forbids — a handler that runs on every keystroke and decides to do nothing, in the state
whose entire promise is that interaction testing behaves as if dogear were absent. Keeping
it would have made the headline claim conditional and left it untestable; the assertion
that means anything is `registry.size === 0`, and it has to be unqualified.

So disabling is terminal in the page, and re-enabling is `__dogear.start()` in the console
or a reload once the preference is cleared. The console handle has existed since B1 and is
already how the teardown is proved by hand, so this adds an affordance rather than
inventing one. A single console line on disable names the way back — the affordance cost
is real and this is what keeps it from being a dead end.

Note the acceptance criteria only ever say *disable*, in both clauses. The one-way reading
was the intended one.

**`enabled: false` injects nothing, rather than injecting something inert.**
The same call the missing-git-root case already makes, and for the stronger reason: there
is no queue-location problem here, just no reason to ship a bundle to a page that asked
for none. No script tag, no endpoint middleware, one line in the terminal. It also settles
precedence for free — an in-browser `localStorage` preference cannot contradict a config
that prevented dogear from reaching the browser at all.

This is **not** a sixth production-safety layer. It is a convenience switch that happens to
be absolute; `apply: 'serve'` is still the defense, and a developer toggling this changes
nothing about what a build contains.

**The queue outlives the session, so disabling never has to refuse.**

The first cut of B6 blocked the kill switch while anything was unsent. B5 had made that
look necessary: the queue lived in the session's closure, so a teardown destroyed it, and
disabling became the one gesture in the overlay that could silently lose work.

Implementing it exposed the refusal as a symptom. The toggle lives in the review panel —
it has to, because while idle with an empty queue dogear renders nothing at all and a
permanently reachable control would cost B7's guarantee. But the panel is only reachable
*from the badge*, and the badge only exists when the queue is non-empty. So the button was
visible in exactly one state, and refused in exactly that state: **a control that could
never succeed.**

The fix is one level down. `createQueue()` moved from the session to the controller, so
the batch survives a teardown and the rebuilt session adopts it with the badge already
counting. Disabling is now instant, unconditional and lossless; re-enabling brings the
batch back. The refusal, the dead-end button, and a silent data-loss path in
`__dogear.stop()` all disappeared together.

This costs neither guarantee it looks like it should. The queue is pure data — no DOM, no
listeners — so while disabled there is still not one handler attached and not one node in
the document. What is kept alive is a JavaScript object holding some text, which a reload
clears exactly as it always did.

One guard survives, and it is not about losing work: a submit already in flight blocks the
toggle for the length of a localhost round trip. Teardown aborts the request, but an abort
is client-side — the POST may already have been written, while the local items are only
cleared on a response nobody read. Disabling there and submitting again after a re-enable
would write the same annotations twice.

The general lesson is worth keeping: *a kill switch that can decline is not one*. "Get out
of my way" is the whole request, and a version that answers "not until you deal with your
queue" is solving a problem the design chose to have.

**`stop()` stays ephemeral; only the toggle persists.**
`window.__dogear.stop()` has meant "tear down now" since B1 and is what makes the teardown
provable by hand. Now that a persisted preference exists, the two could have been merged
under one meaning of "off" — and were not, because a console teardown during a debugging
session would then follow the developer across every future page load in that browser,
with the cause several reloads behind them. Two verbs for two intents: `stop()` for this
page, the toggle for this browser. Both keep the batch, since the queue moved up to the
controller.

**Discovery is a documentation problem, and is solved with words rather than with pixels.**
Nothing is on screen while dogear is idle, so a developer who wants it gone and has never
read anything has no in-page surface to find. The tempting fix — keep the badge visible
always — was rejected twice over: it spends B7's guarantee, and the badge is
`pointer-events: auto` in the bottom-right corner, which is where floating action buttons
and chat widgets live, so it would intercept clicks in every dev session and every browser
test. Instead the chord is named in three places that cost nothing: the panel's footer hint,
the Disable button's tooltip, and one line in the dev-server terminal at startup.

**Source resolution → attribute transform plus selector floor. Fiber walk cut.**
The attribute is exact wherever the transform ran, which in a Vite React app is all of
your own code. The runtime walk would only cover third-party components and portals, at
the cost of an async path built on React internals its own author warns against.
Declining it keeps dogear free of React-internals risk entirely. Revisit only if real
usage produces the annoyance.

**Source paths are git-root-relative, and the transform's `include` globs resolve there too — C1.**
Everything on the receiving end already resolves from the git root: the queue lives at
`<git-root>/.dogear/queue.json`, and D1's MCP server finds its repo by walking up from `cwd`
for `.git`. A Vite-root-relative path would also make three dev servers in one monorepo emit
`src/App.tsx` for three different files into a single queue — the ambiguity C4 exists to
kill, reintroduced one layer down.

The same root governs `include`/`exclude`. Left alone, Vite's `createFilter` resolves
relative globs against `process.cwd()`, which in a workspace is whatever package directory
npm started the dev server in rather than the repo. Anchoring both to the git root means a
pattern a user writes and a path the attribute carries mean the same thing — and it is what
lets one dev server stamp a shared `packages/ui` component imported from outside its own
Vite root.

**The attribute value is exactly three fields, and C5's component name goes in a second attribute — C1.**
`data-dogear-src="file:line:col"` stays a fixed three-way split. C5 (#19) adds the display
name as its own attribute rather than a fourth positional field, because "where available"
is doing real work in that story — anonymous components legitimately have no name, so the
field would be optional and trailing, which is the shape that rots.

Two consequences worth stating. Positions are **1-based on both axes**, anchored at the `<`
of the opening element, so the value reads the way an editor, a terminal file link and a
stack trace read. And `scripts/check-leak.ts`'s `source-attribute` rule matches the literal
`data-dogear-src`, so **C5 must add a second rule naming its own attribute**, or it will
ship an attribute the production-leak gate does not watch.

It must be a *second literal rule*, not a widening of the needle to `data-dogear`. The
example app's own copy renders the text `<script data-dogear>` to explain A1, so that string
is legitimately present in a healthy production build — the same trap the leak-sentinel
entry below describes for the product name, one attribute further along.

**Payload location → ancestor chain, not a single site.**
The `Button.tsx:12` vs `TabBar.tsx:42` ambiguity is unresolvable at click time, because
the disambiguator is the comment the user hasn't typed yet. Send the chain; let the agent
choose.

**Delivery → MCP is the product; hooks are a capability tier.**
MCP is universal but **pull** — the agent must choose to call it, so "type anything" does
not work on its own. A prompt hook is **push** but Claude-Code-only today: Codex's
`userpromptsubmit` is feature-flagged, globally configured, and of unconfirmed injection
capability, and Cursor's `beforeSubmitPrompt` runs cloud-side and cannot inject context
at all.

Building hook-first would produce a tool that works beautifully in one agent and not at
all elsewhere, with portability bolted on later. So MCP is the baseline and carries the
entire feature set, `dogear_resolve` included — which also removes any need to ask a
model to hand-edit JSON. Where an agent supports hooks, dogear gets better; where it
doesn't, nothing is missing. The hook must never be the only place a behavior lives.

**Distribution → global CLI plus local plugin.**
Machine-level tool, repo-level config — the CodeGraph model. It also absorbs the hook,
removing a package that would have existed to hold fifty lines.

**The queue file gets its own package, `dogear-queue` — source-only and never published.
Settled during D1, overturning an earlier call.**
`findGitRoot` was duplicated between `dogear-vite` and `dogear-cli` behind a parity test,
and `git-root.ts`'s header recorded why: all three ways to share it — the CLI depending on
the plugin, the plugin depending on the CLI, or a fourth package — were "worse than a
fourteen-line duplicate", the last one because this document argued against a package
holding fifty lines when it folded the hook into the CLI. That header then said the CLI's
copy should win when D1 landed, which *is* the plugin→CLI edge it had just rejected. It
contradicted itself, so there was nothing to defer to.

Re-decided on merits, because D1 destroys the premise both rejections rested on. The shared
surface is no longer fourteen lines of path-walking: it is the atomic writer plus two new
mutating operations, whose two concurrency rules lose a user's annotations *silently* when
two implementations disagree. And it has two consumers, not one — the "fifty lines with a
single consumer" argument does not reach it.

Between the two live options the material cost is near identical: both are private,
source-only, and inlined by their consumers at build time, so no published artifact gains a
dependency and the install story stays three packages. What separates them is the effect on
`dogear-cli` — folding in would force a bin package to expose `./queue` and `./git-root`
subpaths that are really internal, and leave every later reader asking why a Vite plugin
imports a CLI. A dedicated package keeps every dependency arrow pointing downward.

**Source-only is the load-bearing detail.** `exports` points at `src/index.ts` and there is
no build. CI runs `typecheck` *before* `build`, and `stop-verify.sh` runs it on every
TypeScript turn, so a package whose types came from `dist/` would make typechecking depend
on a prior build — the trap `examples/react-app` is already documented as falling into.

**The resolve instruction is delivered twice — the formatter's footer AND the tool
description — and the duplication is deliberate. Settled during D2.**
A client may render `structuredContent` and drop the text content block entirely. Inspecting
a live session found Claude Code doing exactly that: the `<dogear-queue>` block, and with it
the "call `dogear_resolve` with its id" footer, never reached the model. On the MCP-only
baseline — which this document calls the baseline experience, not an edge case — the agent
was therefore never told to resolve anything, and the loop the D epic exists to close stayed
open.

Tool *descriptions* cannot be dropped that way: they arrive through `tools/list` and sit in
context for the whole session. So `dogear_pending`'s description names `dogear_resolve` as
the next step, and `dogear_resolve`'s forbids hand-editing the queue. The hook path delivers
the footer, the MCP path delivers the description, and neither depends on the other.

Two consequences worth stating. The server was *not* changed to suit one client — declaring
`outputSchema` and returning both content forms is correct, and the fix adds a delivery route
rather than removing one. And these sentences are now pinned by tests, because until D2
nothing asserted their content: the suite checked only that descriptions were longer than
forty characters, so either could have been deleted in a tidy-up without a single failure.

**Two readers, one module: reads may tolerate, writes must refuse. Settled during D1.**
The plugin's reader threw on a corrupt queue and the hook's swallowed everything, in two
packages, guarded by a parity test. Merged, `tryReadQueue` is now *derived* from `readQueue`
so the two cannot drift on the envelope — and the surviving divergence turns out to be a
rule rather than a quirk. The tolerant reader **drops** entries that are not
annotation-shaped, so handing its result to a writer would silently delete a hand-broken
item and report a successful resolve. Every writer therefore reads strictly; only read-only
callers may tolerate. `dogear_pending` tolerates and reports the reason as a tool error —
unlike a hook, an MCP call has an error channel, and telling an agent "nothing pending" for
a file that would not parse is the one answer that makes it stop looking.

**Staleness is a fragment match across every site, not a substring of one file. Settled
during D5 by implementing the original criterion and watching it fail.**

"An item is stale when its text snippet no longer appears in its named file" flags *every*
checkable item in a real queue. Four independent reasons, all found on this repo's own
example app:

- **The text lives at the call site.** dogear's premise is that the innermost site is the
  component's own file — so `Button.tsx` holds `{label}` while the string "Overview" is at
  `App.tsx`, two frames up. Checking only the primary site condemns every component-authored
  element in a component-based UI, which is the case dogear exists for.
- **CSS transforms the text.** `innerText` respects `text-transform`, so a source reading
  `Click log` is captured as `CLICK LOG`.
- **JSX interpolates.** Source `Paragraph {index + 1}.` renders as `Paragraph 1.`, so no
  whole-snippet comparison can ever succeed.
- **Source wraps, snippets do not.** `describe.ts` collapses whitespace before capping; the
  file it came from is indented and hard-wrapped.

So: normalize both sides (lowercase, collapse whitespace), search **every** file the item
names, and accept a five-word window rather than the whole snippet for snippets longer than
that. Checking all the sites is not re-anchoring — the pin is never rewritten, and the
decision above still stands; it only widens where we look before *flagging*.

**A short snippet falls back to a narrower window rather than demanding the whole thing.
Amended during G3 (#44).**
D5 exempted short snippets from windowing, reasoning that below five words there is nothing
to slide and a one-word window matches almost any file. The floor is right; the exemption was
scoped by the wrong property. It assumed *short* meant *static*, and the third bullet above
already says why that fails: `Count is {count}` renders as `Count is 0` — three words, and
interpolated, so it took the whole-snippet path and could never satisfy it.

G3 found this on the counter button of a stock `npm create vite` app, flagged stale against a
file nobody had touched, with the agent duly reporting that a correct line number was
"likely off". That is the false-stale direction this entry calls the one that matters, on the
most-clicked element of the most-used React starter.

A short snippet now tries the whole thing first and then falls back to a window of
`words.length - 1`, floored at **two** — so `Count is 0` matches on `count is`. Two rather
than one preserves D5's actual concern: a snippet of two words or fewer gets no fallback at
all, so a vanished `Save changes` still flags rather than being rescued by whichever of its
words survived elsewhere.

The asymmetry is what drives every remaining choice. A **false stale** tells the agent to
distrust a correct line number on every prompt, which teaches everyone to ignore the marker
and makes the feature worse than absent. A **false fresh** is the status quo: a wrong line
number goes unflagged and the item still carries three other anchors. Every ambiguity
therefore resolves toward fresh — an item with no text, no sites, or nothing readable is
never flagged, and only a file that is *missing* counts as evidence, because a rename or a
delete is the case worth catching. A file that exists but cannot be read is "could not
check".

Heavily-interpolated short strings — `Showing 24 results`, `Deleted 3 of 12 items` — remain
unmatchable at any window size. That is a floor of the text-snippet anchor rather than a
tuning problem, and it is the price of not re-anchoring.

**`POST /__dogear/prune` → deferred for want of a caller. Settled during D6.**
The endpoint table has listed it since the first draft, and D6's notes called it "the third
caller of the same operation" — but D6's acceptance criteria name only `dogear prune` and
`dogear_prune`, and no story in any milestone gives the route a caller. The overlay has no
prune affordance; D4 is clipboard, D5 is a read-time decoration, and Epic E is install. This
is the same situation B5 found with `GET /__dogear/queue` and resolved the same way: a live
dev-server route reachable only by curl is a third way to do one thing, and an unused route
is a maintenance surface that gets no test pressure from real use. Both surfaces that exist
already satisfy "everything works through MCP", so nothing is missing — only convenience for
a caller that does not exist. Build it when the overlay grows a "clear resolved" control,
which is the only thing that would make it a *shorter* path than the two that ship.

**The clipboard copies the in-memory batch, not the queue file. Settled during D4.**
"Copies the formatted queue" admits two readings, and the acceptance criteria settle it: "works
with no server". The on-disk reading needs `GET /__dogear/queue` — the route B5 found
caller-less and never built — plus a live dev server and a round trip, which is three
dependencies for the tier whose entire claim is that it has none. So the clipboard renders what
the tab is holding.

The consequence is real and accepted rather than engineered around: a successful Submit empties
the batch, so `Ctrl+Alt+P` is an **alternative** to Submit, not a companion to it. A user who
does both delivers the same annotations twice — once as pasted text, once through
`dogear_pending` — with nothing linking the two. That is visible in the paste itself, which says
the items were never queued, and choosing both paths is the user's to choose. Making a copy
*clear* the batch was the alternative and is worse: a clipboard write has no receipt. A 200
proves the annotations reached disk; `execCommand` can report success on a clipboard the OS then
refuses, and the in-memory queue is the one thing in dogear that cannot be recovered. A copy is
therefore a read, and reads do not destroy.

**The formatter moved to `dogear-queue`, behind its own export subpath. Settled during D4.**
Three callers now — the hook, the MCP server, and the clipboard — and the third is the browser.
`dogear-core` declares no dependencies and `dogear-cli` is a bin package with no `exports`
field, so the formatter could not stay where it was. The rejected alternative was a copy in core
guarded by a drift test, which is the pattern already used for `SENTINEL` and the source
attributes: that works for a constant, where the test can compare two strings, and does not for
two hundred lines of rendering, where the test would have to compare behaviour and would only
ever catch the drift it was written for.

`./format` is a **separate subpath from `.`**, and that is the load-bearing part. The package's
main entry imports `node:fs`, which a browser bundle must never resolve — so the browser-safe
module is reachable by a specifier that cannot reach the rest, rather than by a convention
someone has to remember. `format.ts` re-exports `StoredAnnotation` so the subpath is
self-sufficient, and its own suite asserts mechanically that it imports nothing from `node:`.
The failure this prevents is invisible everywhere else: a `node:` import there builds, typechecks
and passes every Node-side suite, and shows up only as an overlay that throws on page load.

**Drafts carry no id, and the formatter omits it. Settled during D4.**
Identity is stamped by the server at submit — a UUIDv7 whose time-sortability a browser-minted
v4 would break — so the items in a clipboard block genuinely have none. The block reads
`[1] — src/Button.tsx:20`, and the positional number is the reader's handle. Nothing is lost:
`dogear_resolve` cannot act on items that are not in the queue, which is what the paste footer
says. The alternative was to send the local `key`, which the queue module already warns will
eventually be mistaken for the server's id — putting it in the id slot in text an agent reads
is that mistake, made deliberately.

**`Ctrl+Alt+P` is global, like `Ctrl+Alt+D` and unlike `⌘/Ctrl+Enter`.**
Submit is guarded on the panel being open, which is what keeps B4's review step unavoidable. The
clipboard is the tier that has to work when nothing else does, so putting a step in front of it
would contradict the only thing it claims. It is stopped hard for the same reason the kill switch
is — an app binding the same chord must not also fire — and it is the one chord that guards on
`event.repeat`, because neither of the others can fire twice and this one can.

**Plugin install → printed, not written. Settled during E8.**
Install step 6 said init *adds* `dogear-vite` to devDependencies. Three things make writing it
wrong, and only the first is temporary.

Both dogear packages are unpublished, so there is no range init can write that `npm install`
resolves — `^0.0.0` names a version the registry does not have, and `*` or `latest` are odd
things to commit into someone else's repository. A manifest edited without a matching lockfile
update fails `npm ci` on the next machine that runs it, which is a breakage init caused in a
repository it claimed to be setting up. And the edit accomplishes nothing on its own: the
config's `import` still fails until someone runs an install, so the command has to be run
either way.

`npm i -D dogear-vite` needs no version-derivation logic in the CLI, cannot desync a lockfile,
and is correct the day the packages publish. It also makes the step symmetric with the decision
already beside it: init prints the `vite.config` change rather than editing it, and now prints
the dependency rather than writing it, for adjacent reasons.

The consequence worth recording is structural: this step has no `Change` at all. It is a runner
phase beside E2's detection remarks rather than an entry in the `Step` list, and E6's teardown
has nothing of it to reverse.

**`dogear init` is not interactive, and never was. Settled during E3.**
This document said "init is interactive" and that step 3 *asks* which agent you use; E2's entry
above went further and predicted E3 would build the prompt layer. Reconciling that against the
code is what E3 actually started with, and the code had already answered: `init()` returns a
string and an exit code, `emit()` is the only thing in the CLI that touches `process.stdout`,
`plan()` may not write or throw, and every `plan()` runs before any `apply()`. A prompt fits
nowhere in that. It cannot live in `plan()`, and asking between plan and apply invalidates what
was planned — which is the one ordering `--dry-run` depends on.

So detection guesses and flags override: `--agent=<name>`, repeatable, and `--no-hook`. Three
things fall out of it. `--dry-run` stops being a substitute for a decline point and becomes the
decline point, which is the role E2 built it for. The command stays assertable byte-for-byte in
the fast suite, which is how `test-built/init.test.ts` can pin what lands in a real repository.
And `--agent` can *subtract* — it replaces what detection found rather than adding to it, which
is the only way to say "I know there is a `.cursor/` here, leave it alone". A prompt could not
have expressed that without asking twice.

The cost is a guess that can be wrong, and it is bounded on both sides: the `agent:` findings
line says what was detected and what marker proved it, above every change, and `--dry-run`
prints the lot before anything is written.

**Agent configs are edited in place, never re-serialised. Settled during E3.**
Adding an entry to `.claude/settings.json` or `.mcp.json` obviously means `JSON.parse` → mutate
→ `JSON.stringify(…, null, 2)`, and that is wrong here for a concrete reason rather than a
stylistic one. This repository's own `.claude/settings.json` writes hook objects like
`{ "type": "command", "command": "bash \"…\"" }` on one line; re-serialising explodes every one
of them onto four. The user asked for a hook and got a 250-line diff to the file they configure
their agent with.

JSON has no file-level append — a second top-level value is not a document — but inserting
before the *enclosing* closing bracket is available, and that is what init does: find the
container, place the entry, leave every other byte alone. Three shapes cover it, and they are
the same primitive with a different path: no `hooks` key, a `hooks` key without the event, or
an existing `UserPromptSubmit` array to join. The third is what "existing hooks survive" means.

Two rules make it safe rather than merely careful. The scanner tracks string literals, so a `}`
inside a shell command is not a closing brace. And the spliced text is parsed before it reaches
disk — if it will not parse, init writes nothing and prints what to add instead. A config with
comments in it lands on that path, which is the graceful degradation rather than a gap: a
commented `.vscode/mcp.json` is an ordinary thing to find, and the right answer is to tell the
user, not to reformat a file they hand-wrote. Verified against the real 250-line settings.json
in this repo: zero lines lost or reformatted.

Two things the format matrix turned up that neither rule covers, both found by writing the tests
rather than by reasoning about them. **A key that is present but wrongly typed has to decline**:
`{"hooks": "x"}` parses, so a merge that only asks "is this an object?" inserts a second `"hooks"`
key — and `JSON.parse` accepts duplicates and keeps the last, so the parse check waves it through
and the user's value is silently shadowed. Init cannot tell a typo it should route around from
data it would be destroying, so it declines and says so. And **the byte order mark has to be
tolerated**: `JSON.parse` throws on a leading one, several Windows editors write them, and
without special handling a perfectly valid `settings.json` is reported as unreadable. It is
stripped for the parse only, never from what is written back.

The alternative considered and rejected was E8's: print it, never write it. It is the safest
option and it costs the ticket — in most Claude Code repos `.claude/settings.json` already
exists, so the hook would never actually be wired, and "merged into `.claude/settings.json`"
would have become "printed for you to paste".

**The registry has two writers, and is keyed by repo root rather than origin. Settled during
E5, correcting this document against itself.**
This document said two incompatible things and neither section knew about the other: the
multiple-dev-servers section had the registry "written by each plugin instance at startup",
and install step 7 had `dogear init` registering the repo. There was no Decisions entry, so
there was nothing to defer to.

Decided on merits, and both halves are needed. **`init` cannot write an origin** — there is no
dev server when it runs. **The plugin cannot be the only writer** either, because E5's own
story is "what's pending across every repo you've init'd", and a registry written only by dev
servers means a repo you set up this morning is invisible until you start Vite. So init writes
that the repo exists and the plugin writes the servers, either may create the entry, and a repo
someone wired by hand without ever running `init` still shows up — which is the more useful
answer anyway.

"At startup" was wrong in a second way that only shows up in code. `configureServer` runs
*before* the server binds, and Vite moves to the next free port when the configured one is
taken — the `:8000, :8001, :8002` case this document opens that section with. So the origin is
knowable only from the listening socket, and the write is deferred to `listening`. Vite's own
`resolvedUrls` is not available there either; it is assigned after the event fires.

Keying by **normalised root** rather than by origin follows from init writing first: an entry
has to exist before any origin does. The normalisation is not fussiness — Node reports a
Windows drive letter's case differently depending on how the process was started, and `init`
typed into a shell and Vite spawned by npm are exactly that pair, so the raw path would give
one repo two entries and `dogear status` would list it twice.

**Liveness is a pid check, not a probe.** The plugin records its pid; `dogear status` sends
signal 0. An HTTP probe of each origin would be more truthful — it proves the server answers,
not merely that a process exists — and it would need an explicit exception to the zero-egress
rule, timeouts, and an async command. A pid can be reused and a process can outlive its
server, both of which heal on that repo's next dev server start. Not worth a socket.

**`dogear status` gets no MCP tool. Settled during E5 — a deliberate exception to a stated
rule.**
"Everything works through MCP" is one of this document's firmest rules, and E5 is the first
capability to ship without a tool. The rule exists so that dogear is not a Claude Code product
with portability bolted on: a feature reachable only through the hook would be exactly that.
`dogear status` is not that shape. It is machine-level orientation for a human — which of my
dev servers is up, which repo has annotations waiting — and every MCP session is scoped to one
repo by construction, since the server resolves its root by walking up from `cwd`. An agent in
repo A asking about repo B is not a capability it is missing; it is a boundary the same-origin
design was built so that nothing would need to cross. `dogear_pending` already answers "what is
pending here", which is the question an agent actually has.

The rule's real target is unchanged and worth restating: no *annotation* capability may live
only on a non-MCP surface. Reading and resolving still both go through the server.

**Detection → a phase before the steps, plus `--dry-run`. Settled during E2.**
E1's `Step` seam was written expecting detection to arrive as another entry in the list, and
that was wrong in a way worth recording. A step's only voice is `Plan.notes`, and notes print
*below* the change list — so detection-as-a-step would have reported what it found after init
had already changed things, inverting E2's second criterion. Detection is therefore a phase:
it runs first, its findings get a labelled section above the changes, and the structured result
reaches every `plan()` as a second argument, which is what E3 needs to wire what detection saw
rather than looking again. Steps that ignore the argument declare the narrower signature and
are unaffected, so E4's three needed no edit.

`--dry-run` is the other half. "Reports before changing" only means something if there is a
point at which you can decline, and a non-interactive command has none — every byte prints at
the end either way. The flag supplies it without inventing a prompt layer. This entry expected
E3 to build one anyway for "which agent do you use"; it did not, and the flag turned out to be
the whole answer rather than a stopgap — see E3's entry below. Plan-every-step-then-apply
already existed for report ordering, so the flag is a branch rather than a mechanism.

Two smaller decisions inside it. **Versions are the declared range, verbatim** — `react
^19.2.0`, never resolved from `node_modules`, which need not exist and would make the report
depend on whether anyone had run an install. And **detection's remarks do not suppress
`nothing changed`, though a step's notes still do**: a repository with no Vite config earns a
remark on *every* run, so folding them together would mean the commonest reason to run init
twice is also the case where it never gives a verdict. A step note qualifies what init did; a
remark describes the repository, which is what the findings already do without silencing
anything.

`pnpm-workspace.yaml` names the layout but its globs are not parsed. Reading them means a YAML
dependency — the CLI has one dependency and it is the MCP SDK — or a hand-rolled parser that
will meet YAML it cannot read. The bounded walk finds the apps regardless; only the package
count is missing, and the report omits the number rather than guessing it.

**Cross-repo isolation → free, via same-origin.**
Each dev server serves its own endpoint and knows its own root, so port collisions across
repos cannot cause confusion. Worth stating because it's a real advantage over the
extension approach, which only sees a URL.

**Package naming → `@dogear/*` via a free npm organization. Superseded during G5 — the
org was taken. The packages publish unscoped as `dogear-{cli,core,vite}`; see the entry
below. The account-versus-org reasoning here still stands and is why it is superseded
rather than deleted.**
The unscoped `dogear` is taken by an unrelated hapi plugin (v5.0.0, last published
2020-05-14; the registry's `modified` timestamp of 2022-06-15 is metadata, not a release).
An npm scope exists only if you own a user or an org of that name, and on npm
an "organization" carries no team semantics — it is simply the mechanism for owning a scope
that isn't already your username. It is free for unlimited public packages and keeps
publishing under one identity. An earlier draft called for a second *personal account*
named `dogear` on the theory that it was less setup; it isn't — an org is one form, while a
second account is a second login and 2FA to maintain forever, and it turns any future
handoff into a password-sharing problem. OIDC trusted publishing is configured per package
and behaves identically either way. GitHub repo names are per-owner, so other `dogear`
repos are irrelevant — the only cost is search-result noise.

**Framework scope → React first-class; others unsupported for now.**
The attribute transform is JSX-only. With the fiber walk cut, Vue and Svelte get nothing
but the selector floor until someone writes their transforms.

**Leak sentinel → a distinct token, internal to core, and the noop is scanned too.**
Layer 4 says "CI grep for a sentinel string in `dist/`", which understates two traps.

First, the marker cannot be the product name. `examples/react-app` ships a `<title>` and an
`<h1>` reading "dogear example", so grepping for `dogear` fails on a perfectly healthy
build. Hence a distinct `__DOGEAR_DEV_ONLY__`.

Second, and less obvious: the sentinel must **not** be part of core's public API. `noop.ts`
mirrors `index.ts`'s exports, and the noop is precisely what the `production` and `default`
conditions resolve to — so a publicly exported sentinel would ship the literal string in
every correct production build and make the check fire on a working repo. It lives in an
internal `sentinel.ts` that `index.ts` does not re-export, so there is nothing for the noop
to mirror.

Which `dist/` is therefore not one answer but three: the consumer bundle
(`examples/react-app/dist`) and `packages/core/dist/noop.js` are scanned;
`packages/core/dist/client.js` is not, since it legitimately carries the sentinel. The
manifest is checked too — dogear in `dependencies` rather than `devDependencies` is a leak
the content grep cannot see.

*(Corrected during F4. This sentence named `dist/index.js` as the file that legitimately
carries the sentinel, and that was never true: `sentinel.ts` is not imported by `index.ts`, so
the literal never reached the library bundle. Nothing was scanning the wrong file — the
conclusion was right and the reason was wrong — but it mattered once F4 asked whether the
served bundle could carry the sentinel. `index.js` **cannot**: making it do so would need an
export, which the parity test would force `noop.ts` to mirror, which ships the literal into
every correct production build. The dev-client entry `client.ts` can, because it is in no
exports map and has no noop counterpart.)*

**Sentinel in `dogear-vite` → a second copy behind a drift test, not an import from core.**
A1 makes the plugin the sentinel's first emitter, which raises the question of how the
plugin reaches a constant that lives in core. The obvious answer — a `./sentinel` subpath on
core's exports map — was rejected. Importing `dogear-core` by name resolves through the
exports map to `dist/`, so `npm run typecheck` would need a prior `npm run build`; typecheck
runs on every turn that touches a `.ts` file, so that is a permanent cost for a frozen
twenty-character string. A relative import of core's source is unavailable too:
`packages/vite/tsconfig.build.json` sets `rootDir: "src"` and declaration emit rejects
anything above it. And architecturally the plugin never imports dogear's browser half — it
emits a `<script>` tag — so keeping `dogear-core` unresolvable from the Node-side plugin
keeps that boundary honest. The duplicated literal is safe because a test in
`packages/vite/src` imports both and fails on divergence; test files sit outside
`tsconfig.build.json` and the tsup entry, so the `rootDir` rule does not reach them.

**Host allow-list → one list, three pattern kinds — private ranges inside it, not beside it.**
This document contradicted itself, and F3 is where it got settled. The Config block listed
`hosts` as four name patterns with no private ranges, while layer 5 said "bail unless
localhost, `127.0.0.1`, `[::1]`, `*.local`, **or a private IP**" — which reads as a
hard-coded allowance sitting next to the configurable list. Both are now the single list,
and `hosts` understands exact hostnames, `*.suffix` wildcards, and IPv4 CIDR ranges.

The deciding argument is what E4 inherits. Someone who narrows `hosts` to `["localhost"]`
is saying "stop running on my LAN address", and a separate always-on private-IP rule would
silently ignore them. One list means "what is allowed" has exactly one answer, and a
caller-supplied list *replaces* the defaults rather than extending them.

Three consequences worth recording. **`*.localhost` is in the defaults** because RFC 6761
reserves the whole TLD to loopback, which makes `app.localhost` provably local rather than
a guess — and suffix matching anchored at a label boundary cannot reach `localhost.evil.com`.
**The loopback entry is `127.0.0.0/8`, not `127.0.0.1`**, since 127.0.0.2+ are equally
loopback and get used to separate concurrent dev servers. **IPv6 ULA (`fc00::/7`) and
link-local (`fe80::/10`) are deliberately absent**: they need `::` expansion, zone-ID
stripping, and 128-bit prefix arithmetic for a case nobody has hit, and adding them later
is a fourth matcher arm plus two list entries, not a redesign. IPv6 addresses are therefore
matched exactly, so `::1` is recognised and its expanded `0:0:0:0:0:0:0:1` form is not —
reachable only from a hand-written config entry, since browsers normalise to the short form.

**The bail is silent, and the noop denies rather than re-exports.**
Two smaller F3 forks, both of which follow from *when* layer 5 actually runs. It fires only
in the scenario where every structural layer already failed and core is live in a real
user's browser — so a `[dogear] refusing to initialize` console warning would announce a
dev tool on the one page it must be invisible on. Diagnostics belong on the dev-side path,
where B1 can add them.

For the same reason `noop.ts` hand-writes its own always-denying counterparts instead of
`export … from './host.js'`. Re-exporting would ship the matcher — CIDR arithmetic, suffix
rules, the default list — into every correct production build, which is precisely what
layer 3 exists to prevent, and would leave the inert module reporting `localhost` as
allowed while being incapable of acting on it.

**`origin` is derived by the server, not sent by the client. Settled during C4.**
The browser already sends `url` (`location.href`), so `origin` looked like a client field —
it is a prefix of one the client is sending anyway. It is not. `origin` answers *which dev
server wrote this*, which is the same class of question as `id` and `createdAt`, and the
existing split in `annotation.ts` puts every such field on the server's side: the browser
describes what it saw, the server owns identity. Two things follow that the client-side
version gets wrong. A hand-written `curl` batch sends no `url` at all, and it is exactly the
case the agent-facing formatter's `url → origin` fallback exists for — reading `origin` from
the client would make that fallback dead code. And a batch arriving at one dev server could
claim to have come from another, which is the precise ambiguity C4 exists to remove in a
repo where several servers share one queue.

The server reads it from the request's `Host` header rather than its own config, because one
dev server answers to `localhost:5173`, `127.0.0.1:5173` and an mDNS `.local` name alike, and
the annotation should record the one actually in the address bar. Scheme comes from
`socket.encrypted`, not `x-forwarded-proto`: trusting a client-settable header to describe
the server's own identity buys nothing here, since F3's guard only lets dogear run on
loopback, `*.localhost` and `*.local` — the reverse-proxy hostnames that header exists for
never have an overlay to submit from.

A consequence worth stating: **`origin` and `app` are stripped from the client's input, not
merely overwritten.** A conditional spread alone would let a client-sent value survive
whenever *this* server resolved none of its own — and a repo whose package declares no name
is exactly where a bogus `app` would go unnoticed. The server's answer is final, including
when the answer is "none".

**The queue lock stays unbuilt, and the write race stays documented. Settled during C4.**
`queue.ts` had promised C4 a lock file to close the window between its read and its rename.
C4 declined to build one. `appendToQueue` is synchronous end to end, so no interleave is
possible *within* a process; across two processes the window is the few milliseconds of `fs`
work between read and rename, reachable only by two people submitting at the same instant in
one repo. Against that: a lock file needs stale-lock recovery, because a dev server can be
SIGKILLed while holding it, and a stale lock that blocks submits is a worse failure than the
one it prevents — it is *silent and permanent* rather than rare. D1's MCP server would
inherit the whole mechanism. The two rules that are built (pid-suffixed temp file,
read-modify-write on every submit) already guarantee the failure is a lost append rather
than a corrupted queue, which is the property worth having. Moved to Still open; revisit
when someone actually loses an annotation.

**Undo is a second list of steps, not a `revert` on each one. Settled during E6.**
E6 left the choice open on the grounds that a second list "avoids burdening E2's detection,
which writes nothing". That argument had expired by the time the ticket was picked up:
detection became a *phase* rather than a `Step` during E2, and E8's guidance block went the
same way, so every member of `stepsFor` is a real writer and none of them would have been
burdened either way.

What decided it instead is `Wiring`. `stepsFor` picks its MCP targets from resolved
detection; undo cannot. Run `dogear init --agent=cursor`, delete `.cursor/`, and detection
now reports `claude` — a `revert` hanging off the wiring-built step would walk straight past
the file it wrote and leave the entry. Undo must scan all three agent configs
unconditionally, so a `revert` on those objects would have to be documented never to consult
the wiring it was constructed from, which is a trap rather than a contract. A separate list
has no wiring to ignore and needs no change to `Step`, `Plan`, `Change` or the report.

The cost is that nothing makes the compiler demand a teardown for a new step, and
`scaffold.test.ts` pins it instead by matching names in both directions. Two step modules
contribute several `Undo` entries rather than one, because a `Plan` carries a single
past-tense summary and undo has two verbs — `deleted` for a file that goes whole, `removed`
for one that is spliced — and a repository with both kinds needs a line of each.

**Undo deletes a file only when it is byte-identical to what init writes. Settled during E6.**
The alternative to the byte comparison was judging whether a document is "empty of meaning",
which would let undo delete a `{"mcpServers": {}}` the user wrote. Byte identity cannot: a
file matching init's fresh output to the byte is one init created and nobody has touched.
Anything else is spliced and every other byte survives.

Two limits are real and were found by running E3's format matrix rather than predicted. A
file that was `{}` before init comes out of the merge byte-identical to init's own output, so
undo removes it — it configured nothing, and the information distinguishing the two cases does
not exist on disk. And undo prunes a hook container its entry emptied, which takes an *empty*
`"UserPromptSubmit": []` that predated init with it; an empty array of hooks and an absent key
are the same configuration, so the cost is zero and the alternative is visible litter in the
common case. The `.gitignore` block and the `AGENTS.md` stanza have a third, smaller version of
the same problem: the separator init writes turns `a`, `a\n` and `a\n\n` into one string, so
removal restores the middle one.

**A `.gitignore` whose dogear block has been edited is reported, not repaired. Settled during
E6.** The three lines must be contiguous and in the order init wrote them, header comment
included — which is what that comment was added for during E4. A line-wise sweep would be
tidier and is wrong for the reason E4 already gave in the other direction: a repository may
perfectly well have carried `.dogear/queue.json` before init ever ran, and deleting a rule the
user wrote costs a committed queue, while leaving two redundant lines costs a `git status`
line.

**`dogear init --undo` refuses `--agent` and `--no-hook`. Settled during E6.**
They select what to wire, and undo unwires everything unconditionally — see the entry above.
Ignoring them would leave someone who typed `--undo --agent=cursor` believing they had asked
for something narrower than what happened, which is the same asymmetry that already makes an
unrecognised argument a failure rather than something to skip.

**Tooling → npm workspaces, TypeScript 7, tsup, vitest, Prettier. No ESLint.**
npm workspaces because pnpm isn't installed and this doesn't need it. TypeScript 7 is the
native compiler and current `latest`; typechecking runs on every turn that touches a `.ts`
file, so its speed is felt constantly. The only place the native port is exposed is `.d.ts`
emit, which goes through the compiler API — transpilation is esbuild and never touches
`tsc`. The fallback if that path misbehaves is `tsc --emitDeclarationOnly`.

No ESLint: with `strict` on and Prettier owning formatting, a linter's remaining yield on a
project this size didn't justify the config surface. `lint` is defined as
`format:check && typecheck` so the name still means something.

**`dogear-vite` depends on `dogear-core` at `^0.1.0`, not `*` and not a pin. Settled
during G2.**
G2 (#43) was scoped as the `private` flag and the version, on the stated grounds that the
manifests were otherwise written correctly when each package was created. They were, with one
exception that only becomes wrong at the moment the flag drops: the dependency was `"*"`, a
workspace wildcard that resolves to the local copy while developing and **publishes
verbatim**, so any future `dogear-core` — including one that changed the bundle contract —
would satisfy an installed plugin.

`^0.1.0` rather than an exact pin because this document already assumes the two version
independently: the `hosts` entry above omits the key from the wire precisely so a plugin one
release behind cannot override core's list, which presumes they can move separately. Under
0.x semver `^0.1.0` is `>=0.1.0 <0.2.0` — core ships patches on its own, and a `0.2.0` that
changes what the plugin serves at `<endpoint>/client.js` forces a plugin release, which is
the coupling that genuinely exists.

The consequence worth recording is that a wildcard is now a **test failure** rather than a
convention: `scripts/packaging.test.ts` refuses `*`, `latest` and the `workspace:` protocol
forms, because `*` is what `npm install -w` writes back and the regression would otherwise be
silent until someone installed the published plugin.

**The three packages release in lockstep. Settled during M6, and it narrows G2 rather than
reversing it.**
Every release bumps `dogear-core`, `dogear-vite` and `dogear-cli` to the same version,
including packages with no change in it. Core at `0.1.1`, vite at `0.1.5` and cli at `0.1.8`
is a state nobody can reason about from a version number: three numbers describing one
product, where the only question a user actually has is "which dogear am I on". The npm cost
of a no-op bump is a version nobody needed; the cost of divergence is every future support
question.

**This is a release policy, and it does not touch the caret range or the `hosts` entry above,
because those are about installed trees rather than published ones.** Lockstep controls what
leaves this repository together. It cannot control what a user's `node_modules` holds — a
caret range still admits a core that moved without the plugin, which is exactly the drift the
`hosts` omission and `test-packed/install.test.ts`'s nested-copy assertion exist to survive.
Pinning the range would close that, and would also mean a core patch could not reach anyone
without a plugin republish, which is a worse trade than the one it fixes.

`scripts/packaging.test.ts` asserts the three versions are identical, so a release pull request
that bumps two of three goes red before it merges. That matters more since #64 than it would
have before: merging is what publishes, so there is no later step at which someone notices.

**Being wired is two independent facts — a manifest declaration and a config that calls the
plugin — and init checks both. Settled during G3.**
E8 keyed `guidance()` on `DetectedApp.plugin` alone, which is a *manifest* fact, on the
reasonable-sounding grounds that an app already declaring the plugin does not need telling to
install it. True, and it answers the wrong question: `npm i -D dogear-vite` makes the
declaration true and changes nothing about the config. G3 (#44) did the two steps in that
order and found init reporting `nothing changed` with no snippet over an app whose overlay
could never load. It is the same trap E1 named — *check for the state you need, not for the
path being occupied* — one level up.

`DetectedApp.configured` is the second fact, and each half of the block is now printed only
when its own half is missing: an app with the package and no plugin call gets the snippet and
is **not** told to install what it already has, and the install line's `then,` lead — which
only reads as a sequel to a snippet — becomes `install it` when it stands alone.

It is a **substring test, not a parse**, and the asymmetry with `guidance.ts`'s refusal to
rewrite a config is the point: rewriting safely requires parsing, and a wrong guess is a dev
server that will not start, while deciding whether to *print a hint* fails cheaply in both
directions — a stray mention in a comment costs a suppressed hint, a missed one costs a
redundant hint beside a config that already works. An unreadable config reads as `false`,
which is the direction that prints.

**A missing local `dogear-cli` is a detection *remark*, not a step note, and it speaks for the
prompt hook too. Settled during G3.**
E3 had `mcp-config.ts` note it, gated on `jobs.length > 0` — reasoning that "a repository whose
configs are all already correct does not need telling how the CLI resolves." G3 (#44) walked
the documented global-only install and found the hole: the config being correct and the path
inside it resolving are different questions. The note fired once, on the run that created
`.mcp.json`, and every re-run afterwards reported `nothing changed` over an MCP server that
exited 1 with `MODULE_NOT_FOUND` on spawn. The warning was transient; the breakage was not.

Re-keying it on a registration *existing* fixed the firing and broke the report: **step notes
suppress `nothing changed`**, so a repository earning this on every run never got a verdict
again — which is precisely the trap E2 already identified for its own remarks, and which the
built-binary suite caught within one run of the change.

The discriminator in `report()` settles where it belongs: *a step note qualifies what init did
or declined to do; a remark describes the repository.* Init declined nothing here — it wrote
the registration, correctly. What is wrong is the repository, and it stays wrong until someone
installs the package. So it is a remark, computed in `scaffold()` from the resolved `Wiring`
rather than folded into `Detection`, which would make the `agent:` findings line report a
preference as an observation. It prints on every run and silences nothing.

It also names the **prompt hook**, which had no warning of its own and is the worse of the two
failures: an MCP server that will not start is silent until you ask for it, while a
`UserPromptSubmit` entry pointing at a missing file fails on *every prompt the user types* —
the same shape E6 (#39) was filed to prevent, arrived at from the other direction. The wording
comes from `Wiring.hook`, so `--no-hook` is not told about a hook it declined, and
`--agent=none` gets nothing at all because nothing then points at `CLI_ENTRY`.

**Unscoped `dogear-{cli,core,vite,queue}` rather than `@<handle>/dogear-*`. Settled during
G5.**
The `dogear` organization was taken, which this document had planned for — but the fallback
it named reintroduces exactly the doubled name the organization was chosen to avoid, and
puts a personal handle in every install line and on every package page. Unscoped costs one
thing and buys two: it gives up the scope as a namespace others cannot squat, and it removes
`--access public` from the release entirely (only scoped packages default to restricted)
while keeping `npm i -g dogear-cli` short enough to read aloud.

The rename is otherwise invisible, and that is deliberate: the binary is still `dogear`, the
plugin export and Vite plugin id are still `dogear`, the MCP server is registered under the
key `dogear`, and every on-disk name — `.dogear/`, `~/.dogear/projects.json`,
`data-dogear-src`, the sentinel, `<dogear-queue>`, `<!-- dogear:start -->`, the three
`dogear_*` tools — is untouched. **The one thing that could not survive the change
mechanically is the production-leak gate.** Its `package-specifier` rule was the prefix
`@dogear/`, which covered a package added later for free; `dogear-` cannot replace it,
because that string is a substring of `data-dogear-src` and `data-dogear-component`, whose
rules sit in the same table. So the gate now names each package explicitly, and
`packaging.test.ts` asserts every published name is in that list — an explicit list is a
list that can go stale, and the test is what stops it.

**The manifest is the manifest. Settled during G4, and untouched by #64.**
What publishes is decided by comparing each `package.json` version against the registry and
skipping what is already there. The alternative — a name that declares the version, refusing
to publish if a manifest disagrees — is simpler to read and makes the trigger authoritative
over the manifests, which is the wrong way round: the manifests are what a consumer resolves.
Two consequences worth having: a partially-failed run is re-runnable, because the packages
that made it are skipped rather than colliding; and a trigger that fires with nothing bumped
publishes nothing and goes green, which is why the job emits a step-summary table rather than
a silent success.

The lockstep entry above does *not* make this redundant. Lockstep is a rule about what a
release pull request must contain, enforced by a test before the merge; the registry
comparison is what the workflow does after it, and it stays the authority on what is already
out there. A release that failed halfway leaves the three genuinely out of step on the
registry, and only the comparison can tell the re-run which two to skip.

**What triggers it moved from a tag to a merge. #64, and the first release is the
evidence.** All three `0.1.0` packages record `gitHead = 0e4ee643`, a commit that is not
reachable from `main`: it lived on `m5-release`, PR #52 was squash-merged, and the branch
commits went with it. So the published packages point at a commit that is not in the
repository's history. It still resolves on github.com, because GitHub retains commits
referenced by a pull request, but `git cat-file -e` fails in a fresh clone.

Nothing caught that and nothing could have, because tagging happens outside CI and outside
review, against whatever commit is checked out. So `release.yml` now runs on
`push: branches: [main]`, and a release is a pull request whose diff reads
`"version": "0.1.1" -> "0.1.2"` with the full CI matrix green against it. **A merge never
invents a version** — the comparison above is unchanged, so the ordinary merges between
releases find every version already published, skip all three and go green. `RELEASING.md`
is the procedure; this entry is the reasoning.

**The credential objection is answered by splitting the job, not by a second lock.** A
merge-triggered publish would otherwise hold `id-token: write` on every merge rather than on
rare tags, and that matters more here than elsewhere because Dependabot proposes bumps to the
very actions that job uses. So the decision is split from the act: an unprivileged `decide`
job does the registry comparison and emits what would publish, and the privileged job runs
only if it says yes. A `release:publish` label was considered as a second lock and declined —
the reviewed version diff is already a deliberate act, and a gate that must be remembered is
a step that will be forgotten, which is the failure mode this whole change exists to remove.

**Tags survive as a record, and are per package.** The workflow pushes `dogear-core@0.1.2`
after npm accepts the publish, one per package that actually shipped, from a job holding
`contents: write` and no OIDC token. Under lockstep a repo-wide `v0.1.2` would also be honest,
and it was weighed: what decides it is that a *partial* release is the case the record has to
survive, and that is precisely when the three are not at one version. A per-package tag names
what npm actually received and needs no rule for the exception. `v0.1.0` and `v0.1.1` remain
as relics of the tag-trigger era. Since tags no longer trigger anything, P2 (#60)'s protection
on `v*` stops being the primary control and branch protection on `main` becomes it.

**The first publish of each package cannot use OIDC, and that is npm's constraint rather
than ours. Settled during G4.**
A trusted publisher is configured *on a package*, and npm has no way to configure one for a
package that does not exist yet (npm/cli#8544; `npm trust` says so outright). PyPI allows
it; npm does not. So each package is bootstrapped by hand — a throwaway `0.0.1` published
interactively, the trusted publisher configured against the new package page, then the real
`0.1.0` published by the workflow with provenance.

**The placeholder takes `latest` and there is no way to stop it.** G4 planned to publish it
under `--tag bootstrap` so the package would carry no `latest` at all, and a plain
`npm i dogear-vite` would then error rather than install a placeholder. That is not how the
registry behaves: every package must have a `latest`, so the **first** publish claims it
whatever `--tag` says, and `latest` cannot afterwards be removed. Found by running it.

What actually covers the window is smaller and sufficient: the placeholder is `npm
deprecate`d, so anyone who installs it in the days before the release gets a warning naming
the version to use, and the tagged release moves `latest` to `0.1.0` on its own. The
exposure is a package nobody has been told exists. `--tag bootstrap` is still passed — it
costs nothing and is correct for any *later* out-of-band publish — but it is not what makes
this safe.

This does not weaken the "no stored credential" rule — the bootstrap is a human at a
terminal with 2FA, not a secret in the repository. What it costs is that the very first
version of each package carries no provenance attestation, which is why the placeholder is
`0.0.1` and deprecated rather than the `0.1.0` anyone installs.

---

## Still open

None of these blocked M0, and none of them blocks the release.

- **Screenshots.** An extension gets `captureVisibleTab` free; a page script needs
  `getDisplayMedia` (a permission prompt every time) or canvas rasterization (heavy,
  imperfect). Possibly unnecessary — a text comment on a located element may be enough.
  Revisit after M3 with real usage to argue from.
- **Whether the Codex hook can inject context.** If it can, `dogear init` gains a second
  push adapter cheaply. Requires reading Codex's hook source or testing it. The cost is
  that it writes to a *global* config file outside your repo, which needs thought.
- **Per-branch queues.** Switching branches mid-batch leaves annotations pointing at code
  that moved. Probably rare enough to ignore; the staleness flag covers the damage.
- **Multi-agent concurrency.** Two agents in one repo resolving the same items. No reason
  to solve it until it happens.
- **A queue lock.** Two dev servers can still interleave between the queue read and the
  rename, and the later writer wins — a lost append, never a corrupted file. Closing it
  needs stale-lock recovery for a dev server that gets SIGKILLed, which is more machinery
  than the race deserves until someone actually loses an annotation. See the Decisions log.

---

## Repo and publishing

- Single GitHub repo, npm workspaces, packages published independently.
- Each `package.json` needs `repository.directory` pointing at its subfolder — without it
  every npm page links to the repo root.
- `files` array so tarballs ship `dist/` and not tests and fixtures.
- The packages are unscoped, so `--access public` does not apply — only scoped packages
  default to restricted. See the naming entry in the Decisions log.

**A release is a merge to `main`, not a tag.** Bump the manifests that moved, let the
lockfile follow, and open a pull request whose diff is versions and nothing else; merging it
is what publishes. Every other merge finds all three versions already on the registry and
goes green having published nothing. **`RELEASING.md` is the procedure** — including which
packages a given change forces to move, which is the part that is easy to get wrong. The
reasoning behind the trigger is in the Decisions log; the runbook does not belong here.

**Publishing uses OIDC trusted publishing from GitHub Actions. This is no longer
optional:**

- npm **permanently revoked all classic tokens on 9 December 2025.** They cannot be
  created or restored. Granular tokens are capped at 90 days and require 2FA.
- Trusted publishing needs no stored credential and **emits provenance attestations
  automatically** — no `--provenance` flag. Provenance is a meaningful trust signal for a
  tool people install into their build pipeline.
- **Provenance requires a public source repository, and this one was private until P5
  (#63).** GitHub withdrew support for provenance from private repositories in July 2023, and
  trusted publishing does not exempt it: the attestation names a repository and a commit that
  a verifier has to be able to reach. **`0.1.0` proved the worse of the two failure modes.**
  The release did not fail; it published cleanly and skipped the attestation in silence, so
  `dist.attestations` is empty on all three packages while `_npmUser` correctly reads
  `npm-oidc-no-reply@github.com`. OIDC worked, provenance did not, and nothing reported it.
  Attestations are made at publish time and cannot be added later, so `0.1.0` can never carry
  one. **G4's provenance criterion is met by `0.1.1`**, the first release from the public
  repository: `dist.attestations` now names a `slsa.dev/provenance/v1` predicate on all three.
  Checked against the registry rather than assumed.
- Trusted-publisher configurations created **after 20 May 2026** must explicitly select at
  least one allowed action. Ours are, so each config names `npm publish` rather than
  relying on the old implicit default.
- It needs **npm ≥ 11.5.1 and Node ≥ 22.14.0**, which is above both floors in `engines`.
  The publish job therefore runs on Node 24 and checks its own npm version; the matrix that
  proves the floors is the verify job. An older npm does not fail with a version message —
  it looks for a token that does not exist and reports an auth error.
- **A trusted publisher cannot be configured for a package that does not exist**, so each
  package's first publish is manual. See the Decisions log.
- The configuration names the **workflow filename**. `release.yml` is part of the publish
  credential: moving or renaming it breaks publishing with an auth error that does not
  mention the file.

**Dependency updates are a signal, not a queue of pull requests. Settled during M7.**
Three things travel under the name Dependabot and only one of them opens routine pull
requests. Alerts are a repository setting and pure signal. Security updates are a setting
too, and open a pull request only when there is a real advisory. Version updates are
`.github/dependabot.yml`, and they open pull requests on a calendar whether or not anything
is wrong.

`dependabot.yml` therefore covers **`github-actions` and not `npm`**. For npm it would be
mostly churn: the devDependencies are tsup, vitest, prettier, typescript and happy-dom, all
of which move constantly, `npm run verify` already fails if any of them breaks something,
and a genuine vulnerability still arrives through security updates. For `github-actions` the
risk is different in kind rather than degree: the workflows pin `actions/checkout@v5` and
`actions/setup-node@v5` by *major* tag, a major tag is mutable, and `release.yml` holds
`id-token: write` against a live trusted publisher, so an action changing underneath us is
the one supply-chain shape that could publish as us.

What replaces npm version updates is #65: a report on every pull request, ranked by severity
**and by whether the package ships**. Only `magic-string`, `dogear-core` and
`@modelcontextprotocol/sdk` ever reach a user, so a raw `npm audit` number weights a
build-tooling advisory the same as a shipped one, which is how a report becomes something
people learn to ignore.

---

## Later, maybe

- **More hook adapters** as agents ship context-injecting prompt hooks. Because MCP
  carries the whole feature set, each new one is a small additive trigger rather than a
  port
- **Runtime fiber walk** as an optional layer, if the attribute transform's gaps prove
  annoying in practice
- Next.js adapter (small, if core stays framework-agnostic)
- Generic sidecar mode: `dogear serve` + one script tag, covering Rails/Django/Go
  templates/anything. This is where `~/.dogear/projects.json` earns its keep, since a
  sidecar *does* have the URL-to-project problem
- Chrome extension as a *second* delivery mechanism for staging URLs and native screenshots
- Vue and Svelte transforms
