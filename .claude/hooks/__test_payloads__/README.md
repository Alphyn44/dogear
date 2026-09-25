# Hook Test Payloads

Sample JSON payloads that mirror what Claude Code pipes to a hook on stdin. Use
them to spot-check a hook script without triggering the actual tool call.

## Usage

```bash
bash .claude/hooks/block-destructive-bash.sh < .claude/hooks/__test_payloads__/npm-install.json
echo "exit=$?"
```

Expected exit codes:

| Payload | Hook | Expected |
|---|---|---|
| `npm-install.json` | `block-destructive-bash.sh` | exit 2 (blocked: dependency mutation) |
| `queue-edit.json` | `block-sensitive-paths.sh` | exit 2 (blocked: agent-owned queue state) |
| `stderr-pager.json` | `block-redundant-stderr-pager.sh` | exit 2 (blocked: redundant `2>&1 \| pager`) |
| `gh-compound-bypass.json` | `block-destructive-bash.sh` | exit 2 (a permitted `gh issue create` must not wave through a `gh issue delete` in the same command) |
| `gh-pr-compound-bypass.json` | `block-destructive-bash.sh` | exit 2 (same, for the PR-description carve-out vs `gh pr merge`) |
| `gh-api-milestone-read.json` | `block-destructive-bash.sh` | exit 0 (the milestones carve-out: a read) |
| `gh-api-milestone-patch.json` | `block-destructive-bash.sh` | exit 0 (the milestones carve-out: editing a description) |
| `gh-api-milestone-delete.json` | `block-destructive-bash.sh` | exit 2 (deleting a milestone strips it from every issue in it) |
| `gh-api-compound-bypass.json` | `block-destructive-bash.sh` | exit 2 (a permitted milestones call must not wave through a second `gh api`) |
| `gh-api-other-endpoint.json` | `block-destructive-bash.sh` | exit 2 (nothing may follow the milestone number, so no `../` out of it) |

An exit of **1** from `block-destructive-bash.sh` is a failure, not a block: the script died
(usually `set -u` on an empty `BASH_REMATCH`) and the command would have run. Every
blocking row above must read exactly 2.

## Why these exist

Inline `echo '{"command":"rm -rf x"}' | bash hook.sh` is an unreliable smoke test:
the destructive-looking text sits in the *outer* Bash command, so the PreToolUse
hook may fire on the test command itself before the script ever runs. Whether it
does depends on quoting — the boundary class doesn't match a preceding `"`, so
quoted forms often slip through and *appear* to work, which makes the failure mode
inconsistent rather than obvious.

Piping from a file keeps the dangerous strings out of the command line entirely and
lets the hook see only the JSON payload on stdin.

Delete this directory at any time — it's purely a developer convenience.
