# Releasing

A release is a merge to `main`. There is no tag to push.

## What triggers a publish

`.github/workflows/release.yml` runs on every push to `main`. Its first job, `decide`, reads
the three `package.json` versions and asks the registry whether each one is already published.
Only what is absent gets published. Nothing else enters the decision: not the commit message,
not a tag, not a label.

| What lands on `main` | What happens |
| --- | --- |
| a PR with no version change | `decide` finds all three on npm, skips all three, green |
| a PR that revs the version | publishes all three, then tags |

`decide` runs once per merge, not per commit. Commits on a feature branch run `ci.yml` through
the `pull_request` event and never reach this workflow. `decide` reads the manifests as they
stand at `main`'s tip, so a branch that bumped a version and reverted it before merging is
invisible.

## How to rev the version

**All three packages move together.** `dogear-core`, `dogear-vite` and `dogear-cli` carry the
same version at all times, including when a package has no change in the release.
`scripts/packaging.test.ts` fails if they diverge.

1. Set the same new `version` in all three `packages/*/package.json`.
2. Run `npm install`, so `package-lock.json` follows. A manifest bumped without its lockfile
   fails the next `npm ci`, which is the first step of every CI leg.
3. Open a pull request whose diff is those four files and nothing else.
   [PR #69](https://github.com/Alphyn44/dogear/pull/69) is the shape.
4. Merge it.

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
three still match.

## What breaks publishing

- **Renaming or moving `.github/workflows/release.yml`.** The filename is part of the publish
  credential. Update all three trusted-publisher configurations on npmjs.com first, or the
  release fails with an auth error that does not mention the filename.
- **A new package.** A trusted publisher cannot be configured for a package that does not exist
  yet, so a fourth published package needs a manual bootstrap publish first. See the brief's
  Decisions log.
- **A tag ruleset covering `dogear-*@*` with no GitHub Actions bypass.** The `tag` job would
  fail on every release.
