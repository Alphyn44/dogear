# Releasing

A release is a merge to `main`. There is no tag to push.

## What triggers a publish

`.github/workflows/release.yml` runs on every push to `main`. Its first job, `decide`, reads
the four `package.json` versions and asks the registry whether each one is already published.
Only what is absent gets published. Nothing else enters the decision: not the commit message,
not a tag, not a label.

| What lands on `main` | What happens |
| --- | --- |
| a PR with no version change | `decide` finds all four on npm, skips all four, green |
| a PR that revs the version | publishes all four, then tags |

`decide` runs once per merge, not per commit. Commits on a feature branch run `ci.yml` through
the `pull_request` event and never reach this workflow. `decide` reads the manifests as they
stand at `main`'s tip, so a branch that bumped a version and reverted it before merging is
invisible.

## How to rev the version

**All four packages move together.** `dogear-core`, `dogear-vite`, `dogear-next` and
`dogear-cli` carry the same version at all times, including when a package has no change in the
release. `scripts/packaging.test.ts` fails if they diverge.

1. Set the same new `version` in all four `packages/*/package.json`.
2. **On a minor bump, move the `dogear-core` range in `dogear-vite` and `dogear-next` too.**
   Under 0.x semver `^0.1.0` means `>=0.1.0 <0.2.0`, so it does not admit `0.2.0`, and npm
   would quietly install a second, older core underneath each host. `test-packed` and the Next
   browser suite both fail when that happens.
3. Run `npm install`, so `package-lock.json` follows. A manifest bumped without its lockfile
   fails the next `npm ci`, which is the first step of every CI leg.
4. Open a pull request whose diff is those five files and nothing else.
   [PR #69](https://github.com/Alphyn44/dogear/pull/69) is the shape.
5. Merge it.

Say why you are releasing in the pull request body. There is no changelog.

## After the merge

| Job | Credential |
| --- | --- |
| `decide` compares each manifest against the registry and writes a summary table | none |
| `verify` runs the five-leg `npm run verify` matrix | none |
| `tarballs` builds and refuses an empty tarball | none |
| `publish` runs `npm publish` for each package `decide` named | OIDC (`id-token: write`) |
| `tag` pushes `dogear-core@0.1.2` and friends | `contents: write` |

`decide` writes its table before anything else runs, so if it says "Nothing to publish" on a
release merge, the manifests did not change the way you thought.

Tags are created after npm accepts the publish, one per package. They record what shipped.
`v0.1.0` and `v0.1.1` are relics of the old tag trigger and are not continued.

If a release fails partway, re-run it. `decide` skips whatever already published, and `tag`
records whatever `publish` got through before it failed.

## Rehearsing

Run `release.yml` by hand from the Actions tab, against any branch. It exercises the version
comparison, the verify matrix, the empty-tarball guard and the summary table, and reports what
it would publish.

It cannot publish. The `publish` job is gated on the event being a push to `main`, and
permissions are granted per job, so a dispatched run never starts that job and never mints a
token.

It does not exercise the OIDC exchange. Each package's trusted publisher on npmjs.com names
the repository, the workflow filename and the allowed action; only a real publish proves the
four still match.

## What breaks publishing

- **Renaming or moving `.github/workflows/release.yml`.** The filename is part of the publish
  credential. Update all four trusted-publisher configurations on npmjs.com first, or the
  release fails with an auth error that does not mention the filename.
- **A new package with no bootstrap.** A trusted publisher cannot be configured for a package
  that does not exist yet, so its first release from CI fails on auth. See below.
- **A tag ruleset covering `dogear-*@*` with no GitHub Actions bypass.** The `tag` job would
  fail on every release.

## Adding a package

npm configures a trusted publisher on a package, and has no way to configure one for a package
that does not exist yet. So a new package's first version is published by hand, as a
throwaway, and only then can CI publish the real one with provenance. The brief's Decisions log
has the reasoning (G4); this is the procedure. `dogear-next` was added this way in J7.

**Do all of it before merging the pull request that adds the package.** That merge is what
asks CI to publish it. If the trusted publisher is not there yet, that package fails on auth.
The others still publish, and the run is safe to re-run once the bootstrap is done.

1. Make the package publishable in the pull request: no `private`, the shared version, a
   `README.md` and `LICENSE` of its own, `files: ["dist", "README.md"]`, its directory in
   `release.yml`'s `decide` loop and its entrypoints in the empty-tarball guard, and its name
   in `PUBLISHED` in `scripts/packaging.test.ts` and `test-packed/fixture.ts`.
   `packaging.test.ts` fails on anything left out.
2. Publish a placeholder by hand, from an empty directory **outside** the repository, so
   nothing of the real build goes out without provenance. Use the package's name and
   `0.0.1`:

   ```sh
   npm login                       # once; npm asks for your 2FA code
   mkdir dogear-next-bootstrap && cd dogear-next-bootstrap
   npm init -y
   npm pkg set name=dogear-next version=0.0.1 license=MIT \
     description="Placeholder. Install dogear-next@0.2.0 or later."
   npm publish --tag bootstrap
   npm deprecate dogear-next@0.0.1 "Placeholder. Install dogear-next@0.2.0 or later."
   ```

   The placeholder takes `latest` whatever `--tag` says (every package must have one), and the
   deprecation is what warns anyone who installs it before the real release moves `latest` on.
3. On npmjs.com, open the package's **Settings** and add a trusted publisher: GitHub Actions,
   owner `Alphyn44`, repository `dogear`, workflow filename `release.yml`, no environment, and
   `npm publish` as the allowed action. The same values as the other packages.
4. Merge. `decide` finds the real version absent, and `publish` sends it with provenance.
   Check the package page afterwards: the version should carry a provenance badge.
