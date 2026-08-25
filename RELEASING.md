# Releasing

**A release is a merge to `main`.** There is no tag to push and no button to press. Open a
pull request that bumps the versions you mean to ship, get it green, merge it — that is the
release.

The reasoning is in [`dogear-brief.md`](./dogear-brief.md)'s Decisions log. This file is the
procedure.

## What actually triggers a publish

`.github/workflows/release.yml` runs on every push to `main`. Its first job, `decide`, reads
each of the three `package.json` versions and asks the registry whether that exact version is
already published. **Only what is absent gets published.** Nothing else enters the decision —
not the commit message, not a tag, not a label.

So the ordinary rhythm looks like this:

| | What lands | What `decide` finds | What happens |
|---|---|---|---|
| PR 1 | a feature | all three versions already on npm | skips all three, green |
| PR 2 | a fix | same | skips all three, green |
| PR 3 | docs | same | skips all three, green |
| PR 4 | **version bumps** | the new version is absent | publishes, then tags |

Three merges cost one short `decide` job that holds no credential and publishes nothing. The
fourth is the release.

`decide` runs once per **merge**, not per commit. Commits you push to a feature branch never
reach this workflow — they run `ci.yml` through the `pull_request` event. And `decide` reads
the manifests as they stand at `main`'s tip, so a branch that bumped a version and reverted it
before merging is invisible; only what actually landed counts.

## Cutting a release

### 1. Decide which packages move

They version **independently**. `dogear-core`, `dogear-vite` and `dogear-cli` are three
packages that happen to be at the same number today, not one product with one version. Bump
only what changed.

**The one coupling that is easy to miss:** `dogear-vite` depends on `dogear-core` at `^0.1.0`.
Under 0.x semver that range means `>=0.1.0 <0.2.0`, so:

- Core moving **inside** the range (`0.1.1` → `0.1.2`) ships on its own. Nothing else to do.
- Core moving **outside** it (`0.1.x` → `0.2.0`) requires widening `dogear-vite`'s dependency
  range **and** bumping `dogear-vite` too. Skip that and npm cannot satisfy the range from the
  new core, so it quietly installs a *second, older* core underneath the plugin. The install
  succeeds, the dev server starts, and a user gets the new plugin paired with the old overlay.

You do not have to catch that by remembering it.
[`test-packed/install.test.ts`](./test-packed/install.test.ts) asserts that no nested
`dogear-core` exists in a real install, so the mistake fails `npm run test:packed` in CI on the
pull request rather than on the registry.

### 2. Bump the manifests and let the lockfile follow

Edit `version` in each `packages/*/package.json` that is moving, then:

```sh
npm install
```

That updates `package-lock.json` to match. **Do not skip it** — a manifest bumped without its
lockfile fails the next `npm ci`, which is the first step of every CI leg.

### 3. Open a pull request whose diff is only versions

[PR #69](https://github.com/Alphyn44/dogear/pull/69) is the worked example: three
`package.json` files and `package-lock.json`, nothing else. That is the shape to aim for. The
whole point of publishing from a merge is that the version change is reviewable, and a release
PR carrying unrelated code makes the diff you are meant to be reviewing hard to see.

Write down *why* you are releasing in the PR body. It is the only prose record — there is no
separate changelog.

### 4. Merge it

Squash or merge commit, it makes no difference: one push event, one workflow run.

## What happens after the merge

Five jobs, split so that no job holds more privilege than it needs:

| Job | What it does | Credential |
|---|---|---|
| `decide` | Compares each manifest against the registry; writes a summary table | none |
| `verify` | The full `npm run verify` matrix, five legs | none |
| `tarballs` | Builds and refuses an empty tarball | none |
| `publish` | `npm publish` for each package `decide` named | OIDC (`id-token: write`) |
| `tag` | Pushes `dogear-core@0.1.2` and friends | `contents: write` |

Watch the run's summary page. `decide` writes what it is about to do before anything else
happens, so if the table says "Nothing to publish" on a release merge, the manifests did not
change the way you thought.

### Tags

The workflow creates them, **after** npm accepts the publish, one per package that actually
shipped: `dogear-core@0.1.2`. They are a record of what went out, not the thing that made it go
out. `v0.1.0` and `v0.1.1` are relics of the old tag trigger and are not continued.

### If a release fails partway

Re-run the workflow. `decide` will find whatever already published and skip it, so a re-run
only attempts what is genuinely missing. This is why the comparison is against the registry
rather than against a tag: the registry is the thing that cannot be wrong about what exists.

The `tag` job records whatever `publish` got through before it failed, so a half-finished
release does not lose the tags for the half that shipped.

## Rehearsing, without publishing

`release.yml` can be run by hand from the Actions tab against any branch. It exercises the
version comparison, the full verify matrix, the empty-tarball guard and the summary table, and
reports what it *would* publish.

It cannot publish. The `publish` job is gated on the event being a push to `main`, and
permissions in GitHub Actions are granted per job — so a manually dispatched run never starts
that job and therefore never mints an npm token at all. There is no flag to get wrong.

**What a rehearsal cannot prove is the OIDC exchange itself**, which is the part most likely
to be misconfigured: each package's trusted publisher on npmjs.com names the repository, the
workflow filename and the allowed action, and a mismatch in any of the three fails
authentication. Only a real publish exercises that. A rehearsal shrinks the unknown; it does
not remove it.

## Things that will break publishing

- **Renaming or moving `.github/workflows/release.yml`.** The filename is part of the publish
  credential — each package's trusted-publisher configuration names it. Renaming it revokes
  publishing, and the failure is an auth error that does not mention the filename. If it has to
  move, update all three configurations on npmjs.com first.
- **A new package.** A trusted publisher cannot be configured for a package that does not exist
  yet, so a fourth published package needs a manual bootstrap publish before the workflow can
  ever publish it. See the brief's Decisions log.
- **Tag protection without a bypass.** If a ruleset is added covering `dogear-*@*`, it must
  exempt GitHub Actions or the `tag` job fails on every release.
