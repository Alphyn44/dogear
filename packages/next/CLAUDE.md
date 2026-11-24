# dogear-next: the `next.config` wrapper

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

**The phase check is the primary production defense, and it is equality.** `withDogear` returns
the user's config, the same object, unless the phase is `phase-development-server`. Never test
"not building": `next start` evaluates the config in `phase-production-server`. The literal is
typed `typeof PHASE_DEVELOPMENT_SERVER` through a type-only import from `next/constants.js`, so a
rename in Next fails typecheck while `dist/index.js` loads nothing from `next` at runtime.

**One endpoint server per process, held on `globalThis[Symbol.for('dogear-next.state')]`.**
Turbopack's dev server evaluates the config twice in one process. A second server would be a
listener the first evaluation's rewrite never reaches, and every `[dogear]` line would print
twice, so `say()` dedupes messages through the same state. `stopEndpointServers()` exists for
tests and is deliberately not exported from `index.ts`.

**The rewrite has `basePath: false` and goes first in `beforeFiles`.** The overlay POSTs to an
absolute path that knows nothing of the app's `basePath`, and `beforeFiles` runs ahead of the
app's own routes, so a catch-all page cannot answer `/__dogear/annotations` with HTML. A user's
bare-array `rewrites` is what Next treats as `afterFiles`, so it moves there.

**Stamping is one loader, `dist/loader.js`, registered under both bundlers (J2).** It is a second
tsup entry that `index.js` names by absolute path and never imports, so evaluating `next.config`
never loads Oxc's native binding. Turbopack runs it in a worker process, so its options
(`gitRoot`, `include`, `exclude`) are JSON and the filter is compiled inside the loader from
`dogear-host/filter`; `RegExp` patterns are therefore not accepted under Next. Turbopack gets rules
at `*.jsx` and `*.tsx` with `condition: { not: 'foreign' }` and **no `as`** (J1's spike: `as`
renames the module). webpack gets a top-level `enforce: 'pre'` rule, which runs ahead of
`next-swc-loader` in every layer. A user rule at the same glob is kept, with ours **first**,
because Turbopack runs matching rules in order and the stamp must describe the file as written;
a user `webpack()` runs before ours. The loader never throws: a failure passes the source through
and emits one warning per process. Registered only when the endpoint is (dev phase, git root,
server up), and since J4 **whatever `transform` says**: the loader also carries the overlay's tag,
and with `transform: false` it only injects (`stamp: false` in its options).

**The overlay is a tag the loader writes into every JSX `<html>` (J4).** `withDogear` builds the
tag's `src` with the same `buildClientConfig`/`clientScriptSrc` Vite uses (modifier, endpoint,
`hosts` from the file) and hands it to the loader as `clientSrc`. The tag follows neither `include`
nor `exclude`, which govern stamping only. That is why the rules cover **`*.js`** too: a `.js` file
that neither mentions `<html` nor matches `include` passes through unparsed. `dogear-core` is a
runtime dependency, reached only as `dogear-core/package.json` by `resolveCoreDist`; an unbuilt core
warns once through `say()`, and the route serves the stub that says so in the browser. **The limit:**
an `<html>` that is not JSX in the app's own source (a dependency's component, `createElement`)
gets no tag and no message.

**The start directory is `process.cwd()`.** Next gives a config no way to learn its project
directory: `next dev` forks its server without a `cwd`, and the directory travels in the private
`NEXT_PRIVATE_DEV_DIR`. `npm run dev` and its kin start in the app, which is the case that
matters. For `next dev <dir>` from elsewhere, the git root is still right, and the `app` option
fixes the tag.

**Importing `next`'s types brings its global augmentation.** `next/types/global.d.ts` gives
`NodeJS.ProcessEnv` a required `NODE_ENV`, which broke a weak-type check in `dogear-queue`'s
registry (fixed there with `defaultEnv()`). Any other all-optional env interface compiled beside
Next's types will hit the same error.

**`test-built/next-dev.test.ts` copies its fixture into `packages/next/.scratch/`, not `tmpdir`.**
Turbopack will not read outside its project root, and `next` realpaths through H3's junction
into this repository. Inside the package, Node finds the workspace's modules by walking up, and
the copy's bare `.git` still stops `findGitRoot` first, so no annotation reaches the developer's
own queue. That same `.git` is also where Turbopack bounds its root, which is why the generated
config sets `turbopack.root` to this repository. Stopping uses `taskkill /T` on Windows, because
`next dev` forks its server and `child.kill()` would orphan it holding the port; since J6 (#82)
that lives in `startNext` in `test-packed/fixture.ts`, shared with `test-browser/next.test.ts`. Every spawn sets
`NEXT_TELEMETRY_DISABLED=1`. Since J2 the copy also gets a `.dogear/config.json` that excludes
`skipped.jsx`, and the stamp assertions compute each expected `line:column` from the fixture
file, so editing a fixture comment cannot break them. **No fixture file may spell the
attribute name or the sentinel**: the build leg scans every file under `.next/`, source maps
included, and Turbopack's maps embed the source verbatim. Since J4 the root layout is
`layout.js` (and the config's `include` adds `.js`), so real bundlers prove `.js` injection, and
the config sets `hosts` so the tag's config can be checked.

**`test-built/fixtures/leak/` is `check:leak`'s Next build, a separate app on purpose (J4).** It
is built in place by `scripts/build-next-fixture.mjs` into its own `.next/` (gitignored), and the
dev suite above copies `test-built/fixture/` recursively, so sharing one directory would carry a
stale production build into every dev copy. Its `gated.jsx` is layer 2 in Next's form; its marker
names no dogear package, so a surviving branch trips one rule, not two.
