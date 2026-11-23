# dogear-cli: init, its steps and undo, status, hook and mcp

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

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
`claude-settings.ts` (named `hook-config.ts` until #76). A new step is an entry in `stepsFor`; it does not edit the runner. A step's
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
`mcp-config.ts`, `rules.ts` and `claude-settings.ts` are *factories* taking a resolved `Wiring`
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

**#76 made `.claude/settings.json` one step's file, holding two parts.** `claude-settings.ts`
writes the prompt hook *and* `permissions.allow` rules for dogear's three MCP tools, as one
`Step` and one `Undo` named `claude-settings`. Two steps would each have had to simulate the
other's edit, since every `plan()` runs before any `apply()`, to report `created` against
`merged` and `deleted` against `removed`. Three rules. **The rules are a literal `ALLOW`,
never derived from `TOOLS`**, and `claude-settings.test.ts` pairs them, so a new tool fails a
test instead of being pre-approved in every repo initialised after it ships. **Any rule naming
`mcp__dogear` in `allow`, `ask` or `deny` means someone decided**, so the rules are not
topped up; undo removes only the three exact strings, only from `allow`. And **the rules are
not the hook**: `--no-hook` still writes them, a part that cannot be placed becomes a note
without blocking the other, and undo recognises three fresh files (both parts, rules only, and
the hook-only file every init before #76 wrote). Cursor gets a `Plan.note` from
`mcp-config.ts` instead, attached to the run that registers it so re-runs keep their verdict;
see the brief's Decisions log for why neither Cursor nor VS Code gets a file written.

**`removeAt` is `insertAt`'s mirror and shares its scanner; `pruneEmpty` is the cascade after
it.** One asymmetry: `insertAt`'s path names the *container*, `removeAt`'s names the *member*.
A file is deleted **only when it is byte-identical to what init writes fresh** — anything else
is spliced. Two limits, both found by running `formats.test.ts` rather than predicted: a
`.mcp.json` that was `{}` before init is indistinguishable from one init created (a
`settings.json` no longer is, since #76 merges its two parts in the opposite order to the fresh
file), and `pruneEmpty` takes an
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

**H6 added the linker (now `CliHome.linker`, read where the CLI lives since #75), and it is
separate from the manager for the reason `manager` is separate from `workspace`.** Yarn spells the layout `nodeLinker` and pnpm has the
same setting with the same `pnp` option, so *which tool installs here* cannot answer *is there a
`node_modules` for `CLI_ENTRY` to resolve through* — and only the second question bears on the
committed path. It is read from the generated `.pnp.cjs`/`.pnp.js`, never from `.yarnrc.yml`:
the setting may be inherited from a parent directory or left at Yarn's default and written
nowhere, while the artefact is always there. Same shape as `managerOf` reading the lockfile
rather than the intent behind it. **The PnP arm of `cliNotInstalled` is checked *before*
`CliHome.state`, and that order is the whole fix** — `cliIn` answers `'local'` from the manifest
declaration when the file is absent, which is right for a repo mid-clone and wrong for one that
will never have the file, so a PnP repo reached the old guard as `local` and init wrote a path
resolving nowhere in silence. Reordering is not an option either: under PnP the install the
other arm prescribes is the one the user has already done. It is a **remark**, not a step note
and not a refusal, by the discriminator `cliNotInstalled` already documents — init wrote the
registration correctly and it is the repository that is wrong. `test-packed/managers/` is the
suite that proves all of it, including the negative; Yarn 1 is deliberately uncovered, since
Berry supplies both the `node-modules` leg and the PnP one and classic has no PnP mode.

**Everything E3 writes points at `node <path>`, never `dogear`** — a global npm bin on Windows is
a `.cmd` shim the exec form cannot run. The MCP configs use the repo-relative
`node_modules/dogear-cli/dist/cli.js` (an absolute global path would be committed and broken for
everyone else who clones; `Detection.cli` earns a note when it is not installed yet), and the hook
uses `${CLAUDE_PROJECT_DIR}/…` because a hook's working directory is the session's, not the
repo's. `test-built/init.test.ts` asserts both.

**#75 made that path depend on where the CLI lives, and `Detection.cli` is now a `CliHome`.** A
repository with a root `package.json` (or a CLI installed at the root) keeps the root form,
byte for byte. One without, such as a Go repository with its frontend in `web/`, gets
`web/node_modules/…` through `cliEntry(dir)`: the first package in the *sorted* walk that declares
or holds `dogear-cli`, else the first Vite app's own package. `childrenOf` sorts because
`readdirSync` order is the filesystem's and "first" must match on every clone. With nowhere at
all, `Detection.cli` is `undefined`, `resolveWiring` wires **no agent, `--agent` included**, and
`nowhereToInstall` says why as a remark. Three consequences to keep: `Wiring.entry` is resolved
once so the MCP registration and the hook cannot disagree; a registration naming any other path
earns a **stale note, never a rewrite**, because `registered()` alone reported `nothing changed`
over #75's broken hook; and **undo rebuilds `fresh()` from the path the file itself names**,
since it never runs detection and a root-only comparison would splice a file init wrote whole.
`test-built/init.subdir.test.ts` executes the committed entries through a junction, with a
negative control proving the root path fails there.

**#85 ruled that a root `package.json` keeps the root**, even when only a nested package or a
workspace member declares `dogear-cli`; the brief's Decisions log has why. What it changed is the
advice: every install command goes through `installCommand(manager, pnpmWorkspaceRoot)` in
`guidance.ts`, which adds `-w` for pnpm in a directory holding `pnpm-workspace.yaml`, because
pnpm 9 refuses the add there without it. `pnpmWorkspaceRoot` is read per install directory on
`CliHome` and `DetectedApp`, never from `Detection.workspace`, which only sees the git root.

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
would corrupt it. The install command follows `DetectedApp.manager` (the lockfile nearest the
app's package, since #75; it was the root's alone) and names `DetectedApp.manifestDir`, which is
not always the app's own directory. With no manifest above the app it names the app's own
directory, never a root that has none.

**J5 made an app a Vite app or a Next app, through one field, `DetectedApp.host`.** A Next app
is a directory holding `next.config.{js,mjs,ts,mts}`, Next 16's own list, so `.cjs` is not one.
`plugin` asks about the host's own package and `hostVersion` replaces `viteVersion`; everything
else, #75's CLI-home fallback included, applies to both hosts unchanged. **`dogear-next` is a
runtime dependency, the inverse of `dogear-vite`**: `next start` loads `next.config`, so the
import must resolve in production. `installCommand` takes a `field` for that, guidance prints
`npm i dogear-next` with no `-D`, the runtime-dependency remark is Vite-only, and a Next app gets
the opposite remark when `dogear-next` sits in devDependencies. `appRouter` is `undefined` for
Vite and earns a remark when `false`, because a Pages Router app renders no JSX `<html>` for the
tag. The rules step now treats the stanza as written if **any** candidate holds it: `next dev`,
run by an agent, creates an `AGENTS.md` of its own, and checking only the target would append a
second stanza to it in a repository that kept dogear's in `CLAUDE.md`.

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
