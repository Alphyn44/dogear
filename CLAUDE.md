# CLAUDE.md

## What dogear Is

**dogear** — click an element in a running app, leave a comment on it, and have a
coding agent receive that comment already bound to the exact source file and line.
A Vite plugin, an overlay, and an MCP server. No extension, no IDE change.

- **Product name:** dogear (lowercase, everywhere — code, comments, docs, UI strings)
- **Repository:** `dogear`
- **Packages:** `dogear-cli`, `dogear-core`, `dogear-vite`
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

Every issue you create follows `.github/ISSUE_TEMPLATE/story.md` (or `bug.yml`).
GitHub only applies those templates to the web form, never to `gh issue create
--body`, so matching the format is on you — read the template file and follow it.
`bug.yml` is an issue *form*, so there is no body to copy: reproduce its labels as
headings, in order, and answer each one.

Title format is `<story ID> — <short title>`, e.g. `C1 — Attribute transform`, so
issues map back to the brief at a glance. **The brief is the spec; the issue is
the tracker.** If the two disagree, change the brief first. Never let an issue
become a second source of truth.

**Close an issue when its work lands on the working branch, not when that branch
merges.** Work happens on one long-lived branch per milestone (`milestone-0-items`
and so on), and a `Closes #N` commit trailer only fires when the commit reaches
`main` — so relying on the trailer would leave every issue in the milestone open
until the whole thing merged, then close them in one batch. Keep writing the
trailer (it is a useful record, and closing an already-closed issue is a no-op),
but close by hand as each ticket lands so the milestone progress means something.

Before closing: tick the acceptance criteria that are genuinely met, and leave a
comment recording what landed, what deviated from the plan and why, and anything
the next ticket inherits. Design *reasoning* still belongs in the brief — the
comment says what happened, not what we decided to build.

### Explain Non-Obvious Choices

When you pick a pattern or structure that isn't self-evident — Vite plugin hook
ordering, an AST-transform decision, an MCP protocol detail — explain the why briefly.
Don't over-explain basics.

---

## Architecture

| Package | Responsibility |
|---|---|
| `dogear-core` | Overlay UI, source resolution, clipboard export, POSTs to a configurable endpoint. Framework-agnostic — knows nothing about Vite. |
| `dogear-vite` | Dev-only plugin. Stamps source attributes onto JSX, injects core, serves the endpoint. |
| `dogear-cli` | `dogear` on PATH: `init` (with `--undo` since E6), `hook`, `mcp`, `prune`, `status` — all implemented since E5. |
| `dogear-queue` | The queue: git-root walk, atomic read/write, annotation identity, and the agent-facing formatter at the `./format` subpath. Also E5's machine-level registry. **Private, source-only, never published** — see below. |
| `dogear-host` | What the two hosts share: the endpoint, the config-file reader, the app name and the client-tag helpers. Moved out of `dogear-vite` by J3; the transform follows in J2. **Private and source-only**, like `dogear-queue`. |
| `dogear-next` | The second host: `withDogear(nextConfig, options)`, a `next.config` wrapper that does nothing outside `next dev`. Since J3 it serves the endpoint behind a rewrite. **`private: true` until J7 publishes it.** |

**`dogear-queue` and `dogear-host` have no build and are not published.** Each one's `exports`
points straight at `src/index.ts`. Every package that uses one (`dogear-vite`, `dogear-next`,
`dogear-cli` and `dogear-core` for the queue; `dogear-vite` and `dogear-next` for the host) lists
it as a **devDependency**, and their tsup configs set `noExternal` so it is inlined at build
time. A **published type** must not name either one, because tsc copies the import into
`dist/*.d.ts`; that is why `DogearOptions.modifier` spells its union out. Two consequences worth
knowing: the published install story is still three packages with no new runtime
dependency, and `npm run typecheck` keeps working with **no prior build** — which it must,
because CI typechecks before it builds and `stop-verify.sh` typechecks every TypeScript
turn. A built fourth package would have put `dist/*.d.ts` on that critical path, which is
the trap `examples/react-app` already documents.

### Where the rest lives

Package-, workflow- and harness-specific notes sit beside the code they describe, and load when Claude works with files there: `packages/queue/CLAUDE.md`, `packages/host/CLAUDE.md`, `packages/next/CLAUDE.md`, `packages/cli/CLAUDE.md`, `packages/vite/CLAUDE.md`, `packages/core/CLAUDE.md`, `.github/CLAUDE.md`, `test-packed/CLAUDE.md`, `test-browser/CLAUDE.md` and `scripts/CLAUDE.md`. Update the one nearest the code that changed. Three of their rules are repeated here because breaking them is silent:

- **`packages/queue/src/format.ts` must never import a `node:` module.** The overlay loads it in the browser, and a violation passes every Node-side suite.
- **Never rename or move `.github/workflows/release.yml`.** Its filename is part of npm's trusted-publisher credential, and the failure is an auth error that does not mention it.
- **Every suite that reaches `dogear init` must isolate the registry** (`isolateRegistry()` in `test-repo.ts`), or it writes into the developer's real `~/.dogear/projects.json`.

The flow: **browser → HTTP POST → `<git-root>/.dogear/queue.json` → MCP server →
agent.** The bridge is a file, never a socket. Both halves are independently testable
and the state is inspectable with `cat`.

### Key Design Rules

The brief has the full reasoning; the code is authoritative on mechanism.

- **Everything works through MCP.** The MCP server carries the entire feature set —
  reading pending annotations and resolving them. A capability that can't be reached
  through MCP doesn't ship. **One deliberate exception since E5:** `dogear status` has no
  tool, because every MCP session resolves one repo from `cwd` and cross-repo state is a
  boundary the same-origin design exists to avoid needing. The rule's target is unchanged —
  no *annotation* capability may live only on a non-MCP surface. See the brief's Decisions log.
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

## Commands

Node `^20.19.0 || >=22.12.0` (Vite's own floor). One `npm install` at the repo root
resolves all seven workspaces.

| Command | What it does |
|---|---|
| `npm run verify` | The full gate: `format:check → typecheck → test → build → test:built → typecheck:example → build:example → build:fixtures → check:leak` |
| `npm run typecheck` | `tsc --noEmit` per package, plus `scripts/`. Deliberately excludes the example — see below |
| `npm test` | vitest across all packages and `scripts/*.test.ts`. Build-independent by design |
| `npm run test:built` | Suites that spawn the built binary — A4's zero-bytes-on-stdout and hook-timeout guards, plus D1's MCP server driven by a real client, and J3's endpoint behind a real `next dev` under both bundlers. Needs a build first |
| `npm run test:packed` | **H1's install gate.** Packs the three tarballs, installs them outside the workspace once per Vite major the plugin admits (I1), and runs the binary, `dogear init` and a real dev server whose served app must carry its stamps. Needs a build first; deliberately not in `verify` |
| `npm run test:browser` | **H3's round trip.** Drives Chromium against a real dev server: modifier-click, comment, submit, then reads `.dogear/queue.json`. Needs a build and a browser binary; deliberately not in `verify` |
| `npm run check:leak` | **F2's production-leak gate.** Scans built output for dogear's sentinel; needs a build first |
| `npm run build` | tsup for JS, `tsc --emitDeclarationOnly` for types, four packages |
| `npm run build:example` | Production Vite build of `examples/react-app` — what the leak check scans |
| `npm run build:fixtures` | Production build of F1 layer 2's gated-import fixture; also scanned by `check:leak` |
| `npm run dev:example` | Dev server for the example app. **Builds core and the plugin first** — see below |
| `npm run format` | Prettier write; `format:check` is the read-only form |
| `npm run lint` | Alias for `format:check && typecheck`. **There is no ESLint** |

Two things that will bite otherwise:

- **Declarations come from `tsc`, not tsup.** tsup's `dts` bundles `rollup-plugin-dts`
  compiled against the TypeScript 5.7 compiler API, and it dies on
  `useCaseSensitiveFileNames` under TypeScript 7. So every `tsup.config.ts` sets
  `dts: false`, and each publishable package carries a `tsconfig.build.json` for
  declaration emit. JS emit is esbuild and was never affected.
- **`typecheck` excludes `examples/react-app`.** The example resolves `dogear-vite`
  through its exports map to `dist/`, so typechecking it requires a build first — and
  `stop-verify.sh` runs `typecheck` on every turn that touches TypeScript. Use
  `npm run typecheck:example` after a build, or just `npm run verify`.

The example consumes the **built** plugin, never its source — and since B1 the plugin serves
`dogear-core`'s **built** bundle at `<endpoint>/client.js`, so the overlay needs a build too.
`dev:example` therefore builds both first. Rebuild by hand after touching either package:
`npm run build -w dogear-core -w dogear-vite`. Skipping it is not silent: the route answers
with a stub module that names the command, and `configureServer` logs the same thing.

`vitest.setup.ts` is shared by the fast and built configs, and does one thing: point
`DOGEAR_HOME` at a temp directory so no suite can write to the real one. See the registry
notes above for why that is a global rather than a convention.

**Six vitest configs, selected by directory.** `npm test` takes `packages/*/src/**/*.test.ts`
plus `scripts/*.test.ts` and stays build-independent, because `stop-verify.sh`
runs it on every turn that touches TypeScript. Build-independent is the rule there, not
hermeticity: `check-leak.test.ts` builds its own temp fixtures, while G1's
`packaging.test.ts` and the two `docs.test.ts` suites read the repository's own committed
files — READMEs, `LICENSE`, manifests — which needs no build and so belongs in the fast run. The other five need a build first:
`scripts/gate/*.test.ts` reads real build output under `npm run check:leak`,
`packages/*/test-built/*.test.ts` spawns `dist/cli.js` or a real `next dev` under `npm run test:built`, H1's
`test-packed/*.test.ts` packs the real tarballs under `npm run test:packed`, H6's
`test-packed/managers/*.test.ts` installs them with pnpm and Yarn under
`npm run test:managers`, and H3's `test-browser/*.test.ts` drives a real browser under
`npm run test:browser`. Splitting
on directory rather than filename means no config needs an `exclude` to stay out of another's
way — and `test-packed/*.test.ts` being **non-recursive** is what keeps H1's suite from
swallowing H6's, which is the difference between the `packed` job running four installs per
platform and one. `test-browser/*.test.ts` is non-recursive for a second reason worth knowing:
`test-browser/app/` is the fixture app's *own source*, served to a browser rather than run by
vitest, and a recursive pattern is how a fixture directory ends up being collected as a suite.
They are kept separate rather than merged because `check:leak` is a *gate* answering one
question (did the sentinel leak into production?) — folding a behavioural suite into it would
make the name lie.

**Two `docs.test.ts` suites, and they are source rules rather than behaviour tests.**
`packages/cli/src/docs.test.ts` pins the command list on both READMEs and — since G6 — renders
the root README's `<dogear-queue>` example through `formatQueue` and asserts the file contains
it verbatim, so the one piece of documentation that is also an interface cannot drift.
Since I2 it also holds the CLI README's list of agent signs to `MARKERS` in `detect.ts`,
matched only inside the "What init writes, and when" section, because `CLAUDE.md` and
`.mcp.json` are named elsewhere on that page and a whole-page match passes with the table gone.
`packages/vite/src/docs.test.ts` pins the `.dogear/config.json` key table against
`RECOGNISED_KEYS`, and reads `DEFAULT_HOSTS` out of `packages/core/src/host.ts` **as text**:
the plugin deliberately keeps no copy of that list (serialising one would pin it — see
`ClientConfig.hosts`), and importing `dogear-core` would resolve through its exports map to
`dist/` and put a build on `npm test`'s critical path.

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
