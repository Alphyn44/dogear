#!/usr/bin/env bash
# PreToolUse hook: block destructive or repo-escaping bash commands.
#
# Trigger: PreToolUse with matcher "Bash".
# Behavior: read tool_input.command, exit 2 with an explanation if the command
# matches any block pattern below. Exit 0 otherwise.
#
# Block list is positive-listed; everything else passes through. Git AND gh are
# read-only: the user owns every commit, push, sync, PR merge/create/comment/
# edit. npm is read-only too — see the package-manager section for why.
#
# Deliberately NOT blocked: cat, head, tail, ls, wc, sort, uniq, diff, stat,
# file, jq, node, git status/diff/log/show/blame/ls-files, gh view/list/checks,
# npm run/test/ls, and `npx --no-install <bin>`.

set -u

# shellcheck source=./_parse.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_parse.sh"

HOOK_INPUT="$(cat)"
CMD="$(hook_extract "$HOOK_INPUT" tool_input.command)"

if [ -z "$CMD" ]; then
  exit 0
fi

shopt -s nocasematch 2>/dev/null || true

block() {
  local reason="$1"
  cat >&2 <<EOF
Blocked by .claude/hooks/block-destructive-bash.sh

Reason: $reason

Command: $CMD

If you genuinely need to run this, ask the user to do it manually. This hook
exists to prevent destructive operations (file deletion, dependency and
registry mutations, git/gh mutations) and repo escape (cd). Read/Grep/Glob
handle file access without cd; Edit/Write handle file changes without rm.
EOF
  exit 2
}

# rm — file deletion
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(])rm([[:space:]]|$) ]]; then
  block "rm is blocked. Use Edit/Write to overwrite files; never delete. If a file genuinely must be deleted, ask the user."
fi

# sudo / su — privilege escalation
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(])(sudo|su)([[:space:]]|$) ]]; then
  block "Privilege escalation (sudo/su) is blocked."
fi

# cd — repo escape route, not needed for any tool we have
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(])cd([[:space:]]|$) ]]; then
  block "cd is blocked. Read/Grep/Glob accept absolute paths — you don't need to change directory."
fi

# chmod with broad scope
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(])chmod[[:space:]]+(-R|777|666|a\+rwx) ]]; then
  block "Broad chmod (-R, 777, 666, a+rwx) is blocked."
fi

# truncate(1) — file content destruction
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(])truncate[[:space:]]+- ]]; then
  block "truncate(1) is blocked — it zeroes file contents."
fi

# Git mutations — the user commits, pushes, syncs, and manages branches manually
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(])git[[:space:]]+(commit|push|pull|fetch|merge|rebase|reset|checkout|switch|branch|stash|tag|cherry-pick|revert|clean|restore|apply|am|mv|rm|update-ref|gc|prune)([[:space:]]|$) ]]; then
  block "Git mutations are blocked. The user reviews diffs and runs git commit/push/sync manually."
fi

# GitHub CLI (gh) — read-only by default, with scoped carve-outs for PR
# descriptions, issue management, and label create/edit. `gh` and the Windows
# `gh.exe` (incl. an absolute path) both match.
#
# Reading always passes: gh pr|run|issue|repo|workflow|release
# view/list/checks/diff/status/watch.
#
# ---------------------------------------------------------------------------
# HARD DENIES — checked BEFORE the carve-out flags below, and deliberately so.
#
# The flags are computed over the WHOLE command string, which means a compound
# like:
#     gh issue create "x" && gh issue delete 5
# would set the issue carve-out flag from the `create` and wave the `delete`
# straight through. Anything irreversible is therefore denied here first, where
# no downstream flag can reach it.
# ---------------------------------------------------------------------------

# Issue destruction. Issues cannot be bulk-deleted, `gh issue delete` needs
# admin and prompts one at a time, and issue NUMBERS are consumed permanently —
# so a bad batch has no clean undo, unlike almost any other mistake here.
# transfer/pin/lock change repo-level state rather than an issue's content.
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+issue[[:space:]]+(delete|transfer|pin|unpin|lock|unlock|develop)([[:space:]]|$) ]]; then
  block "gh issue delete/transfer/pin/lock/develop is blocked. Issues can't be bulk-deleted and their numbers are consumed permanently — close them instead, which is reversible."
fi

# Deleting a label strips it from every issue carrying it — destructive and not
# meaningfully undoable. Creating and editing labels is allowed below.
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+label[[:space:]]+(delete|clone)([[:space:]]|$) ]]; then
  block "gh label delete/clone is blocked — deleting a label strips it from every issue that carries it."
fi

# PR lifecycle stays entirely the user's. Listed here (not just in the general
# alternation below) so the PR-description carve-out can never reach it.
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+pr[[:space:]]+(create|merge|close|reopen|ready|review|comment|lock|unlock|checkout)([[:space:]]|$) ]]; then
  block "gh pr mutations are blocked. The user creates, comments on, merges, and closes PRs manually."
fi

# Carve-out: `gh pr edit <n> --body/--body-file/--title` sets the PR DESCRIPTION,
# which the /pr-prep command is permitted to do (a visible, reversible edit).
# Scoped to description edits ONLY: the command must be `gh pr edit`, carry a
# --body/--body-file/--title flag, and carry NONE of the risky flags (--base,
# reviewer/assignee/label/milestone/project mutations).
gh_pr_edit_safe=false
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+pr[[:space:]]+edit([[:space:]]|$) ]] \
   && [[ "$CMD" =~ --(body|body-file|title)([[:space:]=]|$) ]] \
   && ! [[ "$CMD" =~ --(base|add-reviewer|remove-reviewer|add-assignee|remove-assignee|add-label|remove-label|milestone|add-project|remove-project)([[:space:]=]|$) ]]; then
  gh_pr_edit_safe=true
fi

# Carve-out: issue management. Issues are cheap, visible, and reversible —
# closing undoes a create for every practical purpose, and the destructive verbs
# already died in the hard-deny block above.
gh_issue_safe=false
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+issue[[:space:]]+(create|comment|edit|close|reopen)([[:space:]]|$) ]]; then
  gh_issue_safe=true
fi

# Carve-out: label create/edit, so epic/milestone labels can be set up.
gh_label_safe=false
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+label[[:space:]]+(create|edit)([[:space:]]|$) ]]; then
  gh_label_safe=true
fi

# gh run rerun/cancel re-triggers or aborts a CI run. Verify the fix LOCALLY
# instead — a pushed fix re-runs CI on its own, and a rerun confirms nothing a
# local repro doesn't.
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+run[[:space:]]+(rerun|cancel)([[:space:]]|$) ]]; then
  block "gh run rerun/cancel is blocked — it re-triggers CI. Reproduce the failure LOCALLY, fix it, and re-run the local target to verify; pushing the fix re-runs CI automatically. If a check fails ONLY in CI and cannot be reproduced locally, consult the user before any rerun."
fi

if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+(pr|issue|repo|release|run|cache|label|gist|project|ruleset|codespace|extension)[[:space:]]+(create|merge|close|delete|edit|comment|review|reopen|ready|lock|unlock|rename|transfer|develop|fork|archive|unarchive|sync|set-default|enable|disable|cancel|rerun|upload|pin|unpin|install|remove|upgrade|clone|restore|checkout) ]] \
   && [[ "$gh_pr_edit_safe" == false ]] \
   && [[ "$gh_issue_safe" == false ]] \
   && [[ "$gh_label_safe" == false ]]; then
  block "gh mutation blocked. Permitted: issue create/comment/edit/close/reopen, label create/edit, and a scoped 'gh pr edit --body/--body-file/--title'. Everything else on GitHub — PRs, releases, repo settings — the user runs manually."
fi

# gh workflow run triggers CI (its verb 'run' collides with the `gh run` noun, so it
# needs its own rule rather than living in the alternation above).
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+workflow[[:space:]]+run([[:space:]]|$) ]]; then
  block "gh workflow run is blocked — it triggers CI. Read-only gh only."
fi

# gh secret/variable/config/key mutations
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+(secret|variable|config|alias|ssh-key|gpg-key)[[:space:]]+(set|delete|add|import|remove|rm) ]]; then
  block "gh config/secret/key mutation blocked. Read-only gh only."
fi

# gh auth mutations — the user owns gh authentication
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+auth[[:space:]]+(login|logout|refresh|token|setup-git) ]]; then
  block "gh auth mutation blocked (login/logout/refresh/token/setup-git). The user manages gh authentication manually."
fi

# gh api can POST/PATCH/PUT/DELETE any endpoint — block it entirely; reads go through
# the typed subcommands (gh pr|run|issue view/list/checks/diff).
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(/\\])gh(\.exe)?[[:space:]]+api([[:space:]]|$) ]]; then
  block "gh api is blocked — it can mutate arbitrary endpoints. Use read-only subcommands (gh pr|run|issue view/list/checks/diff)."
fi

# ---------------------------------------------------------------------------
# Package manager
#
# dogear IS an npm project that publishes to npm, so this section is the most
# load-bearing part of the file:
#
#   - install/add/uninstall change the dependency set AND run postinstall
#     scripts. Dependency choices are the user's to make and to review; a
#     silently-added transitive dep in a tool people install into their build
#     pipeline is exactly the supply-chain shape we don't want.
#   - publish RELEASES CODE to the registry under the project's own name.
#     Never automatable.
#   - version mutates package.json and creates a git tag.
#
# Allowed: run, test, ls, list, outdated, view, info, audit, why, ping.
# ---------------------------------------------------------------------------
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(])(npm|yarn|pnpm|bun)[[:space:]]+(install|i|ci|add|uninstall|remove|rm|un|link|publish|unpublish|deprecate|version|owner|access|dist-tag|token|login|logout|adduser|exec|dlx|update|up|cache[[:space:]]+clean)([[:space:]]|$) ]]; then
  block "Destructive or registry-mutating package-manager subcommand. Dependency changes and publishes are the user's to run — ask them. 'npm run <script>' and 'npm test' pass through."
fi

# npx — fetches and executes an arbitrary package from the registry, which is
# remote code execution by design. `--no-install` restricts it to binaries
# already present in node_modules, which is the everyday case (tsc, vitest,
# tsup, prettier, eslint) and involves no network at all.
if [[ "$CMD" =~ (^|[[:space:]\;\|\&\(])npx([[:space:]]|$) ]] && ! [[ "$CMD" =~ --no-install([[:space:]]|$) ]]; then
  block "Bare npx fetches and executes packages from the registry. Use 'npx --no-install <bin>' to run a binary already in node_modules, or ask the user to run the fetching form manually."
fi

exit 0
