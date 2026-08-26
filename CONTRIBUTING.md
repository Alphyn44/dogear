# Contributing

dogear is a personal project. Issues are always welcome, and a good bug report is worth
more here than a patch.

**For pull requests: typos, broken links and documentation fixes go straight in. Anything
that changes behaviour wants an issue first.** Not to gate you. The answer is sometimes
that a thing is deliberately out of scope, because the brief's Decisions log is largely a
record of obvious approaches that were tried and rejected for a stated reason, and finding
that out after you have spent an evening on it is a bad trade for everyone. Agreeing the
shape in an issue takes a few messages. Use a blank issue for that: the User story template
is the maintainer's own tracking format and expects a story ID from the brief.

## Getting set up

Node `^20.19.0 || >=22.12.0`. One install at the root resolves all five workspaces: the
three published packages, the private `dogear-queue` that the other three inline at build
time, and the example app.

```sh
npm install
npm run verify
```

`verify` is the gate, and it is the only thing you need to run before opening a pull
request. The [README's Development section](./README.md#development) lists its nine steps
and the two things that will bite otherwise. Chiefly: the example app consumes the **built**
plugin, so a change to `dogear-core` or `dogear-vite` needs a build before the example sees
it.

## Before you write code

**Read [`dogear-brief.md`](./dogear-brief.md).** It is the intent layer: architecture, data
contracts, user stories with acceptance criteria, and a Decisions log explaining why each
fork went the way it did. Most "why on earth is it done like that" questions are answered
there, usually because the obvious approach was tried and rejected for a stated reason.

Three rules the brief spells out, and which reviews will hold you to. (There is also a
[`CLAUDE.md`](./CLAUDE.md) at the root. It is instructions for coding agents working on this
repository, written in the project's own shorthand, and it is not the place to start.)

- **The code is the source of truth; the brief is the spec.** If they disagree, that is a
  bug in one of them, so say so rather than quietly picking a side.
- **Everything works through MCP.** A capability that cannot be reached through the MCP
  server does not ship.
- **Zero network egress.** Nothing leaves localhost. No telemetry, no analytics, no version
  check.

## Pull requests

Keep the change and its reasoning together: if a pull request changes *what dogear does or
why*, the brief changes in the same pull request. A change that lands without its brief
update is how the spec goes stale, and this repository has no second place to record intent.

Tests are table-driven vitest by default and live beside the code. New behaviour needs a
test. The existing suites are the best guide to what that looks like here, and several of
them are "source rules" that read the repository's own files rather than exercising
behaviour, which is deliberate.

CI runs the same nine steps as `npm run verify` on five legs: Node 20.19, 22.12 and 24 on
Linux, plus Node 24 on Windows and macOS. All five must pass. The Node versions are there to
prove the `engines` floors; the platforms are there because dogear is developed on Windows
and several things — the drive-letter casing in the project registry, and the `node <path>`
that `dogear init` writes because a global npm bin on Windows is a `.cmd` shim — exist for
reasons a Linux-only matrix cannot see.

Two CI jobs run alongside that matrix and are **not** part of `npm run verify`:

- **`actionlint`** parses `.github/workflows/`, which nothing in `verify` does — Prettier is
  told to leave YAML alone, deliberately, and validity is a different question from
  formatting. It also runs shellcheck over every `run:` block, which is what checks
  `release.yml`'s publish script. To reproduce it, put
  [actionlint](https://github.com/rhysd/actionlint) 1.7.12 and
  [shellcheck](https://github.com/koalaman/shellcheck) on your PATH and run `actionlint` from
  the repository root. Without shellcheck it still runs, and silently checks less.
- **`npm run test:packed`** packs the three tarballs, installs them into a scratch project
  outside the workspace, and runs the binary, `dogear init` and a real dev server against
  them. It needs `npm run build` first. It is out of `verify` because the install reaches the
  registry, and `verify` is what a release gates on.

A release is a merge to `main` that bumps a package version — there is no tag to push.
[RELEASING.md](./RELEASING.md) has the procedure, including which packages a given change
forces to move.

Fair warning on house style: the conventions here are unusual and load-bearing. Comments
explain *why* rather than what, the brief carries the reasoning that would otherwise live
in a wiki, and there is no ESLint because `verify` is the gate. A pull request that misses
those is not wrong so much as expensive to land, which is the real reason behavioural
changes are better agreed first.

## Security

Do not open a public issue for a vulnerability. Report it privately, as
[SECURITY.md](./SECURITY.md) describes; it also sets out what is and is not in scope for a
dev-only tool, and covers what to do if private reporting is unavailable to you.
