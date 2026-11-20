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
`next dev` forks its server and `child.kill()` would orphan it holding the port. Every spawn sets
`NEXT_TELEMETRY_DISABLED=1`.
