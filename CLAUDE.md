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

**`dogear-queue` has no build and is not published.** Its `exports` points straight at
`src/index.ts`; `dogear-vite`, `dogear-cli` and `dogear-core` list it as a **devDependency**
and their tsup configs set `noExternal` so it is inlined at build time. Two consequences worth
knowing: the published install story is still three packages with no new runtime
dependency, and `npm run typecheck` keeps working with **no prior build** — which it must,
because CI typechecks before it builds and `stop-verify.sh` typechecks every TypeScript
turn. A built fourth package would have put `dist/*.d.ts` on that critical path, which is
the trap `examples/react-app` already documents.

**The formatter lives here too, and it is the one module a browser loads.** `formatQueue`
renders the `<dogear-queue>` block for all three callers — `dogear hook`, `dogear_pending`, and
D4's clipboard export in `dogear-core`. The third is why it moved out of `dogear-cli`: core
declares no dependencies and cli is a bin package with no `exports` field, so a shared file
there was unreachable. It sits behind a **separate `./format` export subpath**, deliberately not
re-exported from `index.ts`, because the main entry imports `node:fs` and core inlines whatever
it resolves into `client.js`. So **`packages/queue/src/format.ts` must never import a `node:`
module** — a violation builds, typechecks and passes every Node-side suite, and surfaces only as
an overlay that throws on page load. `format.test.ts` guards it with a source rule, in the shape
`packages/core/src/listeners.test.ts` established.

**Two readers in `dogear-queue`, and the rule is not stylistic: reads may tolerate, writes
must refuse.** `readQueue` throws; `tryReadQueue` never does and is *derived* from it.
Tolerant reads **drop** malformed entries, so writing one back would silently delete a
hand-broken item — every writer therefore uses `readQueue`. `dogear hook`, `dogear_pending`
and — since E5 — `dogear status` are the tolerant callers. `tolerance.test.ts` is the guard,
replacing the cross-package `parity.test.ts` that went vacuous when the copies merged.

**E5's registry lives in the same package, and the rule above governs it too.**
`packages/queue/src/registry.ts` reads and writes `~/.dogear/projects.json` (overridable with
`DOGEAR_HOME`) with the same `readRegistry`/`tryReadRegistry` split and the same
read-modify-write + pid-suffixed temp file, importing `tempPathFor` rather than reimplementing
it. It is per *machine* where the rest of the package is per *repository*; they share the name
`.dogear` and nothing else, which is why `REGISTRY_DIR` is its own constant. `writeRegistry` is
deliberately **not exported** — the queue exports its equivalent because it has writers outside
that module, and here it does not, so keeping it private makes read-modify-write unhoistable
rather than merely documented.

**Two writers, and the split is the ticket.** `dogear init` writes that a repo *exists*
(`register.ts`, the last step in `stepsFor` and the only one writing outside the repo); the
plugin writes its own dev server. The plugin's write is on `httpServer`'s **`listening` event,
never in `configureServer`** — that hook runs before the port is bound and Vite bumps the port
when the configured one is taken, so `config.server.port` is the request, not the answer.
`server.resolvedUrls` is not usable either: Vite assigns it *after* the event fires. Middleware
mode has no `httpServer` and registers nothing, which is why every case in
`packages/vite/src/index.test.ts` was unaffected — its fake server has none. `registry.test.ts`
beside it is the suite with one.

**Entries are keyed by `registryKey(root)` — forward slashes, upper-cased drive letter.** Node
reports a Windows drive letter's case differently depending on how the process started, and
`init` from a shell versus Vite from an npm script is exactly that pair, so the raw path gives
one repo two entries. The rest of the path keeps its case; it is the user's, and it is
displayed back.

**`dogear status` never writes.** Dead server records are filtered from the display by a
`process.kill(pid, 0)` check and dropped by the *plugin* on that repo's next start; a repo
whose directory has gone is reported, not removed. A whole-file failure exits non-zero (there
is nothing to show), while one repo's broken queue or missing directory costs only that line.
It is also the **only command that does not refuse outside a git repo** — `findGitRoot` is
called just to mark the current one.

**Every suite that reaches `dogear init` must isolate the registry.** `isolateRegistry()` in
`test-repo.ts` does it per suite, and `vitest.setup.ts` pins `DOGEAR_HOME` to a temp directory
for every run as a floor. Without that floor the failure is invisible — nothing goes red, and
the only symptom is the developer's real `~/.dogear/projects.json` filling with entries for
temp directories. `init.test.ts` did exactly this, and it was caught by opening the file.

**`dogear init` is a detection phase and then a list of steps.** `packages/cli/src/init.ts` is
the adapter (validate the flags, resolve the git root, refuse if there isn't one, defer to the
implementation through a dynamic `import()` exactly as `mcp.ts` defers to `server.ts`);
`scaffold.ts` holds the `Step` contract and the runner, and each step lives in a module of its
own — `queue-dir.ts`, `config.ts`, `gitignore.ts`, and E3's `mcp-config.ts`, `rules.ts` and
`hook-config.ts`. A new step is an entry in `stepsFor`; it does not edit the runner. A step's
`plan(root, detection)` **never writes and never throws** — it returns
`{ change?, notes? }` or `undefined` — and that is what makes both idempotency and `--dry-run`
possible without a second traversal. Every `plan()` runs before any `apply()`, which is why
not throwing is a rule rather than a style note: `config.ts` stats `.dogear/config.json` in
the repo where `.dogear` is a regular *file* and gets `ENOTDIR`, which `throwIfNoEntry: false`
does not suppress. Three rules a new step must not break: *idempotency is the absence of a
code path*, so `plan` returning `undefined` is the whole mechanism and there is no separate
`alreadyInitialized()` to drift; **check for the state you need, not for the path being
occupied** — `existsSync` is true for a regular file named `.dogear`, which made init report
`nothing changed` over a repo that could never be written to, at exit 0; and a **note is not a
change** — it is for state init can see and must not repair by guessing, and it suppresses
`nothing changed` rather than joining the change list. `scaffold.test.ts` pins all three.

**E2's detection is a phase, not a step, and the distinction is load-bearing.** `detect.ts`
runs before anything plans, because a step's only voice is `Plan.notes` and notes print *below*
the change list — detection-as-a-step would report what it found after init had changed things,
which inverts the acceptance criterion. So its findings get their own labelled section above
the changes, and the structured `Detection` reaches every `plan()` as a second argument. Three
consequences: `detect.ts`
**never throws** (it runs before every step, so one unparseable `package.json` would take out
an init that had nothing to do with it); **detection's remarks do not suppress `nothing
changed` even though step notes do**, because a repo with no Vite earns one on every run and
folding them together means the commonest re-run never gets a verdict — `test-built/init.ts`
caught that, not a unit test; and **`Change.summary` stays past tense**, with `--dry-run`
converting it through a small verb table in `scaffold.ts` that `scaffold.test.ts` guards, so a
step added with an unknown verb fails rather than shipping `would created`.

**E3's three steps are built per run, and none of them re-serialises the user's JSON.**
`mcp-config.ts`, `rules.ts` and `hook-config.ts` are *factories* taking a resolved `Wiring`
(`resolveWiring` in `scaffold.ts` reconciles `--agent`/`--no-hook` against detection), which is
why `STEPS` became `stepsFor(wiring)` — the same shape `gitignore.ts` already used for its
injected `GitQueries`. They read `plan()`'s `detection` argument not at all: folding a flag into
`Detection` would make the `agent:` findings line report a preference as an observation. Their
order is the brief's Delivery ordering made literal — MCP baseline, then the stanza that gets a
pull-based server pulled, then the hook — so a failure part-way leaves the half that carries the
whole feature set done.

**`json-insert.ts` is the reason this ticket is not a one-liner, and its rules are load-bearing.**
JSON has no file-level append, so adding an entry means inserting before the *enclosing* closing
bracket; `insertAt(source, path, snippet)` does that and leaves every other byte identical.
Three rules: the scanner **tracks string literals**, because a `}` inside `"command": "bash \"…\""`
is not a closing brace; the spliced text is **parsed before it is returned**, so a caller can
never write a config that breaks the user's agent; and `undefined` is an **ordinary answer** —
an absent path or a JSONC file with comments declines, and the step turns that into a `Plan.note`
naming what to add by hand. Do not "simplify" this to parse-and-stringify: this repo's own
`.claude/settings.json` writes hook objects on one line, and re-serialising reflows all 250 of
them. `json-insert.test.ts` pins the byte preservation, including against a replica of that file.

**E6 added a second list, `UNDO_STEPS`, and it is not `stepsFor` reversed.** Each step module
exports an `Undo` beside its `Step` — same `Plan`/`Change`/runner/verb table, one extra
interface in `scaffold.ts` and no change to `Step`. Two rules. The **prompt hook comes out
first and always**: every other residue is inert, while an orphaned `UserPromptSubmit` entry
runs against a deleted path on every prompt the user types, and `applyAll` stops at the first
failure. And it is **driven by `TARGETS`/`CANDIDATES`, never by the `Wiring`** — init with
`--agent=cursor`, delete `.cursor/`, and detection now says `claude`, so a wiring-driven undo
walks past the file it wrote. `unscaffold()` skips `detect()`, `remarks()` and `guidance()`
outright; all three describe a repo being set up. Nothing makes the compiler demand a teardown
for a new step, so `scaffold.test.ts` pairs the two lists by name in both directions.
`mcp-config.ts` and `rules.ts` contribute several `Undo` entries each, because a `Plan` carries
one past-tense summary and undo has two verbs — `deleted` for a whole file, `removed` for a
splice — and a repo with both kinds needs a line of each.

**`removeAt` is `insertAt`'s mirror and shares its scanner; `pruneEmpty` is the cascade after
it.** One asymmetry: `insertAt`'s path names the *container*, `removeAt`'s names the *member*.
A file is deleted **only when it is byte-identical to what init writes fresh** — anything else
is spliced. Two limits, both found by running `formats.test.ts` rather than predicted: a file
that was `{}` before init is indistinguishable from one init created, and `pruneEmpty` takes an
*empty* `"UserPromptSubmit": []` that predated init with dogear's own. Both cost nothing —
they configured nothing — and the alternative is litter in the common case. **`.dogear/queue.json`
is never touched**; `.dogear/` goes only once `configRemoval` has emptied it, which is why
`queueDirRemoval.plan` asks *"will this be empty?"* rather than *"is it?"* — every `plan()` runs
before any `apply()`. Its `apply` uses `rmdirSync`, which refuses on a non-empty directory, so a
lost race fails loudly instead of deleting data. `deregisterProject` lives in
`packages/queue/src/registry.ts` because `writeRegistry` is private there.

**A key that is present but wrongly typed must decline, and the parse check will not catch it
for you.** `{"hooks": "x"}` parses, so a merge that only asks `isObject` inserts a *second*
`"hooks"` key — and `JSON.parse` accepts duplicates, keeping the last, so the guard inside
`insertAt` waves it through and the user's own value is silently shadowed. Both steps therefore
ask `hasOwnProperty` first and return `undefined` when the key exists with the wrong type.
`malformed.test.ts` is the guard; it found this rather than predicting it.

**The BOM is tolerated on read and preserved on write.** `JSON.parse` throws on a leading `﻿`,
which several Windows editors write, so both steps parse through `stripBom` and `isSpace` in the
scanner treats it as whitespace — otherwise a perfectly valid `settings.json` gets reported as
unreadable. It is never stripped from what lands on disk. `formats.test.ts` runs both steps
across the whole matrix — two-space, four-space, tabs, CRLF, minified, BOM, no trailing newline,
value-on-the-next-line, empty object — asserting valid JSON, byte preservation and idempotency
for each, plus that CRLF files gain no lone `\n`.

**Everything E3 writes points at `node <path>`, never `dogear`** — a global npm bin on Windows is
a `.cmd` shim the exec form cannot run. The MCP configs use the repo-relative
`node_modules/dogear-cli/dist/cli.js` (an absolute global path would be committed and broken for
everyone else who clones; `Detection.cli` earns a note when it is not installed yet), and the hook
uses `${CLAUDE_PROJECT_DIR}/…` because a hook's working directory is the session's, not the
repo's. `test-built/init.test.ts` asserts both.

**E8 added a second runner phase, and `dogear init` writes nothing for it.** `guidance.ts`
prints the `vite.config` change and the install command for every app that is not fully wired;
it edits neither the config nor the manifest. **Fully wired is two facts, not one** — G3 (#44)
found init silent over an app that had the package and no `dogear()` in its config, because
E8 keyed on `DetectedApp.plugin` (a *manifest* fact) alone. `DetectedApp.configured` is the
other, a word-bounded substring test on the config file, and each half of the block prints only
when its own half is missing — so an app with the package gets the snippet and is not told to
install what it has. A substring rather than a parse because the failure is cheap in both
directions; rewriting a config would not be, which is why guidance still refuses to. The
manifest half is the part
that looks like a shortcut and is not: no range init could write resolves while the packages
are unpublished, a manifest edited without a lockfile update fails the next `npm ci`, and the
edit does nothing anyway because the config's `import` fails until someone installs. So this
step has no `Change`, which is what makes it a phase beside `remarks()` rather than a `Step`,
and E6 inherits no teardown from it. Its block is appended **outside** the report's two-space
indent — the snippet's own leading whitespace is content the user copies, and the body's indent
would corrupt it. The install command follows `Detection.manager` (from the root lockfile) and
names `DetectedApp.manifestDir`, which is not always the app's own directory.

**E7 gave `.dogear/config.json` its reader, and the layering is three lines of `??` guarding
one rule.** `packages/vite/src/config-file.ts` returns *only the keys that survived
validation*, and `configureServer` layers them as `option ?? file ?? default`. `??` rather
than `||` is load-bearing — it falls through on `undefined` alone, so a literal `enabled:
false` or `transform: false` option still beats the file, and a key the file omits reaches the
**default** instead of a value the layering invented. `Object.keys()` on the result is also
the confirmation line's content, which is why a rejected key is *dropped* rather than
repaired: absent is a state the whole chain already handles. Four ordering facts matter.
`findGitRoot` moved **above** the option resolution, because the file is found from the git
root; the `options.enabled === false` check stayed **above that**, because a plugin option is
dispositive by precedence and a disabled project must not be stoppable by a config it will
never read; the file is read **once**, like `gitRoot` and `app`, so editing it needs a dev
server restart that the confirmation line says out loud; and `app` is **not** layered — it is
per Vite root while this file is per repo, which is the ambiguity C4 added the field to remove.

**Reads may tolerate, writes must refuse — and this file is a read, so nothing in it throws.**
A bad `dogear({ modifier: 'banana' })` still throws in `validateModifier`; the same value in
`config.json` earns a warning and is dropped. The audiences differ: a `vite.config.ts` is the
author's own code, while `config.json` is *committed*, so one person's typo would otherwise
break every clone's `npm run dev`. The endpoint is validated by **calling `normaliseEndpoint`
inside a `try`** rather than by restating its rules — an earlier draft accepted any non-empty
string and let `"endpoint": "/"` throw out of the plugin a few lines later, which
`index.test.ts` caught. That same function now also rejects a protocol-relative `//host` and
anything carrying `?` or `#`: since F4 the endpoint becomes the injected `<script>`'s `src`,
so `//evil.com` would have fetched core from a third-party host.

**`hosts` is the one key with no plugin option, and it is omitted from the wire rather than
defaulted onto it.** It is F3's allow-list — repo-wide safety configuration, so the repo-wide
committed file is where it belongs. `ClientConfig.hosts` is absent unless the file set one,
because serialising `dogear-vite`'s copy of `DEFAULT_HOSTS` would *pin* it: a plugin a
version behind `dogear-core` would keep overriding core's list on behalf of a project that
never chose one. In core it is resolved by **`resolveHosts`, deliberately not by
`resolveOptions`** — `ResolvedOptions` is `createSession`'s parameter and every field on it is
one the session reads, while the list is consumed once by the guard before a session exists.
That split is also what let `init()`'s host check stay literally its first line. `resolveHosts`
is **all-or-nothing** where every other resolution is per-field: a malformed array falls back
to the defaults, because filtering would silently re-widen a list its author was narrowing.
`[]` is well-formed and honoured as "nowhere". `noop.ts` mirrors the new
`isCurrentHostAllowed(hosts?)` arity for the reason its own comment gives.

**The `.gitignore` step asks git, and it is the CLI's only subprocess.** Whether
`.dogear/queue.json` is ignored depends on `.git/info/exclude`, `core.excludesFile`, every
`.gitignore` up the tree, and negation precedence — so `git.ts` shells out to `check-ignore`
and `ls-files` rather than matching lines, and returns `undefined` for "git could not answer",
which callers must not collapse into `false`. It is reachable **only from `dogear init`**;
`init.ts`'s dynamic `import()` of `scaffold.js` is what keeps it out of `dogear hook`'s module
graph, and that is now load-bearing rather than prophylactic. Suites that touch it build real
repositories through `test-repo.ts`, which also blanks `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`
— without that, a developer whose own `~/.gitignore` mentions `.dogear` gets different results
from the same test.

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
resolves all five workspaces.

**`@modelcontextprotocol/sdk` is `dogear-cli`'s only dependency**, and it is reached
through a **dynamic** import in `src/mcp.ts` so it never enters the module graph of
`dogear hook` — which runs on every prompt the user types, under a 10s ceiling with a 2s
budget asserted in `test-built/hook.test.ts`. That is why the CLI's `tsup.config.ts` sets
`splitting: true`: without it tsup inlines the dynamic import and hoists the SDK back to a
top-level import of the file Claude Code spawns every turn. `test-built/mcp.test.ts`
asserts the entry chunk carries no SDK import, and that the only SDK subpaths anywhere in
the bundle are the three stdio-side ones — `streamableHttp` or `sse` appearing there would
mean a network transport had been linked in, which is how the zero-egress rule is enforced
rather than merely promised.

| Command | What it does |
|---|---|
| `npm run verify` | The full gate: `format:check → typecheck → test → build → test:built → typecheck:example → build:example → build:fixtures → check:leak` |
| `npm run typecheck` | `tsc --noEmit` per package, plus `scripts/`. Deliberately excludes the example — see below |
| `npm test` | vitest across all packages and `scripts/*.test.ts`. Build-independent by design |
| `npm run test:built` | Suites that spawn the built binary — A4's zero-bytes-on-stdout and hook-timeout guards, plus D1's MCP server driven by a real client. Needs a build first |
| `npm run check:leak` | **F2's production-leak gate.** Scans built output for dogear's sentinel; needs a build first |
| `npm run build` | tsup for JS, `tsc --emitDeclarationOnly` for types, three packages |
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

**Nothing in `verify` parses the workflow files.** `.prettierignore` excludes `*.yml`, so
`format:check` never sees them and there is no repo-local YAML validation at all — the only
parser that reads `.github/workflows/` is GitHub's, at push time. On the release path that
is *after* the tag exists, which is why the nine steps live in a reusable `verify.yml` that
`ci.yml` calls: every push to an open pull request exercises the same plumbing `release.yml`
depends on, so the only untested part of a release is the publish job itself.

**`release.yml`'s filename is part of the publish credential.** Each package's
trusted-publisher configuration on npmjs.com names the repository, the workflow filename and
the allowed action; renaming or moving the file revokes publishing, and the failure is an
auth error that does not mention the filename.

**The release tag is a trigger, not a manifest.** `git tag v0.1.0` starts the run; what
publishes is decided by comparing each `package.json` version against the registry and
skipping what is already there. That keeps core and vite versioning independently, per G2's
decision, and makes a partially-failed run re-runnable. An `npm view` failure that is *not*
an E404 fails the job on purpose — publishing against a registry that could not be read is
how a version gets silently skipped and never published at all. Note that npm reports a
missing *version* of an existing package with E404 too, exactly as it reports a missing
package; the workflow's comment records this because it is easy to assume otherwise.

**The trigger is under review in #64, and the first release is the argument.** All three
`0.1.0` packages record `gitHead = 0e4ee643`, which is not reachable from `main`: it lived
on `m5-release` and PR #52 was squash-merged. A tag push happens outside CI and outside
review, so nothing caught it. What *publishes* would not change under a merge trigger, since
the registry comparison already skips everything on a merge that bumps nothing; what changes
is that the version diff becomes reviewable. The objection to weigh is that it puts a job
holding `id-token: write` on every merge instead of on rare tags, which #64 answers by
splitting the decision out of the privileged job.

**`0.1.0` has no provenance and never can.** The repository was private when it published,
GitHub withdrew provenance for private repositories in July 2023, and attestations are made
at publish time. `dist.attestations` is empty on all three while `_npmUser` reads
`npm-oidc-no-reply@github.com`, so OIDC worked and only the attestation was skipped, in
silence. The first release after the repository goes public is what satisfies that criterion.

**`.github/dependabot.yml` covers `github-actions` only, and that is deliberate.** npm
version updates would be churn against a `verify` gate that already catches breakage, and a
real advisory still arrives through Dependabot security updates, which are a repository
setting rather than this file. The actions ecosystem is different in kind: the workflows pin
by *major* tag, major tags are mutable, and `release.yml` holds a publishing credential.
#65 is what replaces the npm half, reporting audit results per pull request ranked by
whether the package actually ships.

The example consumes the **built** plugin, never its source — and since B1 the plugin serves
`dogear-core`'s **built** bundle at `<endpoint>/client.js`, so the overlay needs a build too.
`dev:example` therefore builds both first. Rebuild by hand after touching either package:
`npm run build -w dogear-core -w dogear-vite`. Skipping it is not silent: the route answers
with a stub module that names the command, and `configureServer` logs the same thing.

`dogear-vite` depends on `dogear-core` to find that bundle, and resolves
`dogear-core/package.json` rather than the package name — resolving the name from Node names
no `development` condition, so it lands on `dist/noop.js`. A `./dev` subpath would read better
and was rejected: it would be a second live entry point a bundler could follow into
production, which is the hole F1 layer 3 exists to close.

**Three vitest environments, one config.** The DOM suites (`overlay`, `session`, `listeners`,
`teardown`, `describe`, `init.host-bail`, `badge`, `panel`, `controller`, `preference`,
`clipboard`) carry a `// @vitest-environment happy-dom` docblock; everything else stays `node`.
`packages/vite/src/index.test.ts` shares **one** temp git root across the whole file, created
in `beforeAll` — so a test needing a `.dogear/config.json` writes it through the `withConfig`
scope, never a bare `writeFileSync`. A leaked config would be read by every test after it and
they would keep passing, silently running against a configuration they never asked for. All geometry is pure
functions tested in the node environment, because happy-dom has no layout engine and
`getBoundingClientRect` there returns zeros. B5's `submit` suite is `node` for the same reason
— it stubs `fetch` and touches no DOM, which is why the transport is a module of its own.

**Counting listeners in a test: spy on `window` and `document` themselves, never on
`EventTarget.prototype` alone.** happy-dom defines `addEventListener` as an own property on
both, and vitest installs its own `window.addEventListener` wrapper besides — so a prototype
spy records *none* of the window-level listeners, which is nearly all of them. It fails in the
worst way: the count reads zero both while running and after teardown, so every "the listeners
are gone" assertion passes without testing anything. `teardown.test.ts` and
`controller.test.ts` both spy per target for this reason, and both pair a
`> baseline` assertion with the `=== baseline` one so a vacuous pass cannot hide.

`vitest.setup.ts` is shared by the fast and built configs, and does one thing: point
`DOGEAR_HOME` at a temp directory so no suite can write to the real one. See the registry
notes above for why that is a global rather than a convention.

**Three vitest configs, selected by directory.** `npm test` takes `packages/*/src/**/*.test.ts`
plus `scripts/*.test.ts` and stays build-independent, because `stop-verify.sh`
runs it on every turn that touches TypeScript. Build-independent is the rule there, not
hermeticity: `check-leak.test.ts` builds its own temp fixtures, while G1's
`packaging.test.ts` and the two `docs.test.ts` suites read the repository's own committed
files — READMEs, `LICENSE`, manifests — which needs no build and so belongs in the fast run. The other two need a build first:
`scripts/gate/*.test.ts` reads real build output under `npm run check:leak`, and
`packages/*/test-built/*.test.ts` spawns `dist/cli.js` under `npm run test:built`. Splitting
on directory rather than filename means no config needs an `exclude` to stay out of another's
way. They are kept separate rather than merged because `check:leak` is a *gate* answering one
question (did the sentinel leak into production?) — folding a behavioural suite into it would
make the name lie.

**The leak sentinel is internal to `dogear-core` on purpose.** `packages/core/src/sentinel.ts`
is not re-exported from `index.ts`, because `noop.ts` mirrors index's public surface and
the noop is exactly what production resolves to. Exporting it would push the sentinel into
every correct production build and make the leak check fire on a healthy repo.

**The leak gate names each package rather than matching a prefix, and that is G5's one
real cost.** The `package-specifier` rule used to be the scope prefix `@dogear/`, which
covered a package added later for free. Unscoped, the equivalent prefix is `dogear-` — and
that string sits inside `data-dogear-src` and `data-dogear-component`, whose rules are in the
same table, so every stamped attribute would report two findings and the report would name
two rules for one bug. `PACKAGE_SPECIFIERS` in `scripts/check-leak.ts` is the explicit list
that replaced it; `check-leak.test.ts` asserts no needle is a substring of another, and
`scripts/packaging.test.ts` asserts every published name is in the list. An explicit list is
a list that can go stale, and those two are what stop it.

**Two `docs.test.ts` suites, and they are source rules rather than behaviour tests.**
`packages/cli/src/docs.test.ts` pins the command list on both READMEs and — since G6 — renders
the root README's `<dogear-queue>` example through `formatQueue` and asserts the file contains
it verbatim, so the one piece of documentation that is also an interface cannot drift.
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
