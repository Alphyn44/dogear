# Workflows: CI, release and the jobs around them

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

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

**The manifest decides what publishes; a merge to `main` decides when.** `release.yml` runs on
`push: branches: [main]`, and what publishes is decided by comparing each `package.json`
version against the registry and skipping what is already there. That keeps core and vite
versioning independently, per G2's decision, and makes a partially-failed run re-runnable. An
`npm view` failure that is *not* an E404 fails the job on purpose — publishing against a
registry that could not be read is how a version gets silently skipped and never published at
all. Note that npm reports a missing *version* of an existing package with E404 too, exactly
as it reports a missing package; the workflow's comment records this because it is easy to
assume otherwise. **A merge never invents a version**, so the ordinary merges between releases
find all three already published and go green having done nothing. `RELEASING.md` is the
procedure.

**#64 moved the trigger, and the first release is the argument.** All three `0.1.0` packages
record `gitHead = 0e4ee643`, which is not reachable from `main`: it lived on `m5-release` and
PR #52 was squash-merged. A tag push happens outside CI and outside review, so nothing caught
it. What *publishes* did not change — the registry comparison already skipped everything on a
merge that bumps nothing — but the version diff is now reviewable. The objection was that it
puts a job holding `id-token: write` on every merge instead of on rare tags, and the answer is
the job split: an unprivileged **`decide`** does the comparison and emits what would publish,
`verify` and `tarballs` gate on it, and the privileged **`publish`** runs only when it says
yes. A `release:publish` label was considered as a second lock and declined — a gate that must
be remembered is a step that will be forgotten, which is the failure mode this change removes.

**Tags are now a record, per package, pushed by the workflow.** `dogear-core@0.1.2` and
friends, created by a **`tag`** job holding `contents: write` and no OIDC token, after npm
accepts. A repo-wide `v0.1.2` was rejected because it is a name that lies the first time core
patches without vite, which is exactly what G2's caret range exists to allow. `v0.1.0` and
`v0.1.1` remain as relics. Since tags trigger nothing, P2 (#60)'s protection on `v*` stopped
being the primary control and branch protection on `main` became it.

**H5's rehearsal is `workflow_dispatch`, and the *event* is the safety.** Permissions are
job-level, so a dispatched run never starts `publish` and never mints a token — an input
gating the publish *command* (H5's original shape, filed before the trigger moved) would leave
the credential present. The empty-tarball guard therefore lives in its own **`tarballs`** job
rather than inside `publish`: a dry run must reach the guard and must not reach the publish.
The cost is that `publish` builds a second time on a real release, bought so that what npm
attests is what the publishing job itself built.

**`.github/dependabot.yml` covers `github-actions` only, and that is deliberate.** npm
version updates would be churn against a `verify` gate that already catches breakage, and a
real advisory still arrives through Dependabot security updates, which are a repository
setting rather than this file. The actions ecosystem is different in kind: the workflows pin
by *major* tag, major tags are mutable, and `release.yml` holds a publishing credential.
H7 (#65) is what replaces the npm half, reporting audit results per pull request ranked by
whether the package actually ships. H9 (#71) covers the ecosystem's blind spot: it only sees
`uses:` references, so H4's actionlint tarball (pinned by version and checksum as literals)
is invisible to it.

**`ci.yml` carries seven jobs and `verify.yml` carries one, and the split is a rule rather
than an accident.** Everything that reaches the network beyond `npm ci` lives in `ci.yml`:
`workflows` (actionlint), `packed` and `managers` (the registry), `browser` (H3's Chromium
download), `versions` and `dependencies` (H8 and H7).
`verify.yml` is what `release.yml` gates on, so a release must never be able to fail because
a registry, a GitHub Releases download, a browser CDN or npm's audit endpoint was slow, or
because an advisory was published that morning. `verify.yml`'s nine steps are the correctness gate and
nothing else belongs in them.

**H8's `versions` job is the history half of a rule whose source half is already tested.**
`scripts/packaging.test.ts` asserts the three manifests carry the *same* version; `0.1.2 →
0.1.1` across all three passes it, because they still match each other. Comparing against a
*previous* version needs git history or the registry, and `npm test` must stay
build-independent and network-free, so it cannot be a vitest source rule and is a job
instead. Three facts it depends on, each measured rather than reasoned: this repo
**squash-merges**, so `--merges` counts 0 over the whole 0.1.0-to-0.1.1 interval where
`--first-parent` counts 3; **no per-package tags exist yet**, so the "last bump" anchor is
the newest commit whose `version` *blob* differs from its parent's, read as a blob rather
than found with a pickaxe that would depend on Prettier's spacing of a JSON key; and
`sort -V` (release.yml's own idiom, reused rather than reimplemented) **orders prereleases
wrong**, putting `0.1.2-rc.1` after `0.1.2`, which fails open and so is safe for a gate.

**A version is compared against `main`, not against the branch point, and only when the pull
request changed it.** Both halves are load-bearing. Comparing an *unchanged* version against
`main` fails every stale branch, and `strict_required_status_checks_policy` is off so
branches legitimately lag. Comparing a *changed* version against the branch point misses the
real rollback: cut at `0.1.1`, raised to `0.1.2`, while `main` released `0.1.3`.

**Both new jobs carry a standing guard against going green forever, and it is the
`check-leak.test.ts` lesson.** On a healthy repo nothing rolls back and nothing ships an
advisory, so a classifier that always said `bump` and a report that always rendered "0
vulnerabilities" would each pass CI indefinitely while testing nothing. `versions` therefore
runs a **ten-row classifier self-test before the real comparison**, on every run, and refuses
to judge a pull request with a rule that fails its own cases. `dependencies` asserts
`auditReportVersion === 2` and `metadata.dependencies.total > 0`, the direct translation of
`ScanResult.filesScanned`: a scan that examined nothing has not passed, it has failed to run.

**Markdown backticks go in `echo` with `\``, never in a single-quoted `printf` format.**
shellcheck reads a backtick inside single quotes as command substitution that will not expand
and raises SC2016, which actionlint surfaces and exits non-zero on. `release.yml`'s `decide`
job already writes its step-summary table the house way; match it.
