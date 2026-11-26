# test-packed: the install gate

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

**`test:packed` is out of `verify` for a reason that is not speed.** It reaches the registry
for `vite`, `magic-string`, `oxc-parser`, React and the MCP SDK, and `verify.yml` is what `release.yml` gates on —
a release must not be able to fail because a registry was slow. It runs as its own `ci.yml`
job across all three platforms instead. `test-packed/fixture.ts` holds the shared harness:
`packAll` → `createScratchProject` (under `tmpdir`, never inside the repo, because
`findGitRoot` walks *up*) → `startDevServer` → `runInstalledCli`. It is the slowest thing in
the repository by an order of magnitude, so each install is shared by the whole file.
Since J6 (#82) it also serves the two Next suites: `packAll(destination, dirs)` packs any subset
of `PUBLISHED`, and `startNext` and its `taskkill /T` stop, which J3's `next dev` suite used to
keep to itself, live here for both. **Since J7 (#83) `PUBLISHED` is four packages, but a Vite
project installs `VITE_INSTALL`, the three without `dogear-next`.** `dogear-next`'s tarball gets
every per-tarball check in `install.test.ts`, while installing it into the Vite legs would make
npm fetch its `next` peer into each of them; `test-browser/next.test.ts` installs it the way a
Next app does instead.

**Neither pnpm nor Yarn lets a sibling tarball satisfy another package's range, and only npm
dedupes on its own.** Yarn gets `resolutions` in the scratch `package.json`; pnpm gets
`overrides` in a scratch `pnpm-workspace.yaml`, since pnpm 11 ignores package.json's `pnpm`
field, which also makes the scratch root its own workspace root (hence `add -w`). The pnpm leg
went unnoticed until 0.2.0 (J7, #83): it had been installing core from the registry, and passing
because the registry carried the same version. So `cli-path.test.ts` now compares the resolved
core's `dist/client.js` byte for byte with this repository's build, which no registry copy can
match.

**Since I1 (#73) there is one install per Vite major, and the list is written down, not
derived.** `VITE_LEGS` pairs each major with the `@vitejs/plugin-react` major that supports
it, and `install.test.ts` checks it against `dogear-vite`'s peer range in both directions, so
widening the range to a major with no leg fails rather than growing a leg nobody paired. Each
leg's app lists `react()` *before* `dogear()`, which is the order appending to `npm create
vite` gives and the one where only `enforce: 'pre'` keeps the stamps; the in-process
`stamp.integration.test.ts` covers the other order. The stamping case reads the module the dev
server *serves*, after the React plugin's compile, and it was proven non-vacuous by running it
with `transform: false`. A leg without a React plugin (`ScratchOptions.vite` omitted) is what
H6's managers suite still uses.
