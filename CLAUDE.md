# CLAUDE.md

## What dogear Is

**dogear** — click an element in a running app, leave a comment on it, and have a
coding agent receive that comment already bound to the exact source file and line.
A Vite plugin, an overlay, and an MCP server. No extension, no IDE change.

- **Product name:** dogear (lowercase, everywhere — code, comments, docs, UI strings)
- **Repository:** `dogear`
- **Packages:** `@dogear/cli`, `@dogear/core`, `@dogear/vite`
- **License:** MIT — a personal project built in the open.

---

## Source of Truth

**The code is the source of truth.** Docs go stale; the code is what runs. Before
acting on any request, reconcile what is being asked against what actually exists —
never assume a file, function, or behavior is there because a document says so.

`dogear-brief.md` is the **intent** layer: architecture, data contracts, user stories
with acceptance criteria, milestones, and a Decisions log explaining why each fork went
the way it did. It is authoritative on *what we decided and why*, never on *what is
built*. When the brief and the code disagree, that's a bug in one of them — stop and
flag it rather than silently picking a side.

If a ticket contradicts either, flag it, propose a resolution, and ask before writing
code. If the brief has gone stale, say so; correcting it is cheap.

> **Finding code — use CodeGraph.** This repo is indexed. Call the `codegraph_explore`
> MCP tool — or `codegraph explore "<symbols or question>"` — BEFORE grep/Read. One
> call returns verbatim, line-numbered source plus callers and blast radius. It's a
> search index over the code, not a source of truth of its own.

---

## How I Work

### Ask, Don't Assume

Default to asking. Ambiguity is the rule, not the exception.

Before producing a plan or writing code, interview me until two engineers reading your
notes would build the same thing. Walk every ambiguous branch — naming, interface
shape, edge behavior (missing input, partial failure, a queue file that won't parse,
two dev servers writing at once), and scope boundaries.

Use `AskUserQuestion` for real forks: options plus a recommendation. I'd rather answer
15 questions than debug one bad assumption.

Run `/ticket` for the full ticket workflow — it carries the read → grill → plan →
implement → verify sequence.

### Issues

Every issue you create follows `.github/ISSUE_TEMPLATE/story.md` (or `bug.md`).
GitHub only applies those templates to the web form, never to `gh issue create
--body`, so matching the format is on you — read the template file and follow it.

Title format is `<story ID> — <short title>`, e.g. `C1 — Attribute transform`, so
issues map back to the brief at a glance. **The brief is the spec; the issue is
the tracker.** If the two disagree, change the brief first. Never let an issue
become a second source of truth.

### Explain Non-Obvious Choices

When you pick a pattern or structure that isn't self-evident — Vite plugin hook
ordering, an AST-transform decision, an MCP protocol detail — explain the why briefly.
Don't over-explain basics.

---

## Architecture

| Package | Responsibility |
|---|---|
| `@dogear/core` | Overlay UI, source resolution, clipboard export, POSTs to a configurable endpoint. Framework-agnostic — knows nothing about Vite. |
| `@dogear/vite` | Dev-only plugin. Stamps source attributes onto JSX, injects core, serves the endpoint. |
| `@dogear/cli` | `dogear` on PATH: `init`, `mcp`, `prune`, `status`. |

The flow: **browser → HTTP POST → `<git-root>/.dogear/queue.json` → MCP server →
agent.** The bridge is a file, never a socket. Both halves are independently testable
and the state is inspectable with `cat`.

### Key Design Rules

The brief has the full reasoning; the code is authoritative on mechanism.

- **Everything works through MCP.** The MCP server carries the entire feature set —
  reading pending annotations and resolving them. A capability that can't be reached
  through MCP doesn't ship.
- **The queue resolves from the git root, not the Vite root.** One repo → one queue →
  one agent session. A monorepo with three dev servers must not produce three queues.
- **Queue writes are atomic and read-modify-write.** Temp filename includes the pid;
  re-read immediately before writing; never cache the queue at server start. Two Vite
  processes append to the same file, and caching silently eats the other's items.
- **Cross-repo isolation is free — don't build machinery for it.** The browser POSTs
  same-origin, so the dev server that served the page is the one that writes, and it
  knows its own root. Ports never enter the routing decision.
- **`apply: 'serve'` is the primary production defense.** The plugin does not exist
  during build — covering both script injection and the attribute transform. The other
  layers in the brief are backup, not substitutes.
- **No React internals.** Source resolution is the `data-dogear-src` attribute plus a
  CSS-selector/text floor. The runtime fiber walk was deliberately cut; don't
  reintroduce it without raising it first.
- **Zero network egress.** Nothing leaves localhost, ever. No telemetry, no analytics,
  no version check.

---

## Code Style

- **TypeScript throughout**, `strict` on.
- **vitest**, table-driven by default.
- **No stuttering** — `core.Overlay`, not `core.CoreOverlay`.
- **Stubs** get `// TODO(dogear): <description>` and an explicit callout in your reply.

---

## What Not To Do

- Do not commit — I review and commit manually
- Do not run `npm install` — tell me the package and why, and I'll run it
- Do not use placeholders without flagging them explicitly
- Do not skip tests, or the grilling step at the start of a ticket
- Do not assume files or directories exist — confirm first
- Do not work around a hook block; ask me to run the command manually
- Do not ship a capability that can't be reached through MCP
