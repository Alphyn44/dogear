# Security

## Reporting a vulnerability

Report privately through GitHub:
[**open a draft security advisory**](https://github.com/Alphyn44/dogear/security/advisories/new).
Please do not open a public issue.

dogear is a personal project with one maintainer, so be realistic about response times: I
will acknowledge within a week, and I would rather you chase me than assume I saw it. If
GitHub's private reporting is not available to you for some reason, open a public issue
saying only that you have something to report and asking for a contact route, with no
details in it.

## Supported versions

The latest published `0.1.x` of each package. There is no long-term support branch and no
backporting; a fix ships in the next release.

## What is in scope

dogear is **dev-only by design**, and that shapes what a vulnerability looks like here.

The most serious class is anything that lets dogear reach a production build or a real
user's browser, because that is the guarantee the whole architecture is built around. Five
layers exist to prevent it: the plugin's `apply: 'serve'`, a gated dynamic import, export
conditions resolving to a noop module, a CI check that fails on a leaked sentinel, and a
runtime hostname bail. **A way past any of them is worth reporting**, including a build
setup where the sentinel or a `data-dogear-src` attribute survives into production output.

Also in scope:

- **The dev server endpoint.** The plugin serves routes under `/__dogear` and accepts a
  POST that writes to `.dogear/queue.json` at your git root. Anything that turns that into
  a write outside the queue, a path traversal, or a request another origin can make
  successfully.
- **The host allow-list.** `hosts` in `.dogear/config.json` decides where the overlay will
  initialise. A hostname that matches when it should not is a real finding, particularly a
  suffix or CIDR pattern reaching something outside the intended range.
- **Anything that leaves localhost.** dogear makes no outbound requests at all: no
  telemetry, no analytics, no version check. A code path that contacts a remote host is a
  bug regardless of what it sends.
- **What `dogear init` writes.** It edits `.mcp.json`, `.cursor/mcp.json`,
  `.vscode/mcp.json`, `.claude/settings.json`, your agent rules file, `.gitignore` and
  `.dogear/config.json`, and those edits are committed. It also writes
  `~/.dogear/projects.json`, which is **outside the repository**. A crafted repository state
  that makes it write something a user would not expect, or write anywhere else, is in scope.
- **The release pipeline.** Publishing uses OIDC trusted publishing with no stored
  credential. Anything that could cause a package to publish from a source other than a
  tagged commit on this repository is the highest-severity report you could send.

  Note that `0.1.0` was published before this repository became public, and provenance
  requires a public source repository, so those three versions carry **no attestation**.
  `npm audit signatures` finding nothing for `0.1.0` is expected rather than a finding.
  Attestations are made at publish time and cannot be added afterwards, so the first release
  published after the repository went public is the first one that has them.

## What is not in scope

- **dogear running on a page in your own browser during development.** That is the product.
  A comment box and a local file write on `localhost` are the intended behaviour.
- **The queue file being readable.** `.dogear/queue.json` is ordinary machine state in your
  own working tree, holding text you typed.
- **A dev server exposed deliberately.** Running Vite with `--host` and reaching it from
  another machine on your LAN is a choice you made; the default `hosts` list allows private
  ranges precisely so that works. Narrow `hosts` if you would rather it did not.
- **Vulnerabilities in Vite, Node or npm themselves.** Report those upstream.
