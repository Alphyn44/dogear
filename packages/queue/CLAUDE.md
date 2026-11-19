# dogear-queue: the queue, the registry and the formatter

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

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
