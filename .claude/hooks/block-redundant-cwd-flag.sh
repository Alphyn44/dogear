#!/usr/bin/env bash
# PreToolUse(Bash): block redundant "change-directory-first" flags.
#
# Several tools accept `-C <dir>` to mean "run as if you'd cd'd here first":
#   git -C <dir> ...
#   go  -C <dir> ...   (Go 1.20+)
#   make -C <dir> ...
#   tar -C <dir> ...
#
# In this project the agent's CWD is always the dogear repo, so `-C` is always
# redundant. Worse, it breaks the permission allowlist: a rule like
# `Bash(git log:*)` matches commands starting with `git log`, not
# `git -C <dir> log ...`, so every redundant invocation prompts the user.
#
# This hook blocks those forms with an instructive message. The agent then
# retries as `git log ...`, `npm run ...`, etc., which match the allowlist and
# run unprompted.
#
# Cross-repo / cross-directory work is out of scope for this project. If you
# ever need it, disable this hook.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_parse.sh"

HOOK_INPUT="$(cat)"
CMD="$(hook_extract "$HOOK_INPUT" tool_input.command)"

[ -z "$CMD" ] && exit 0

# Match `<tool> -C` as the leading tokens. Anchored at start-of-string so we
# don't false-positive on `-C` appearing later in a pipeline or as a different
# flag (e.g. `patch -C` is --context, not change-dir).
if [[ "$CMD" =~ ^[[:space:]]*(git|go|make|tar)[[:space:]]+-C([[:space:]]|$) ]]; then
  TOOL="${BASH_REMATCH[1]}"
  cat >&2 <<EOF
Blocked: '$TOOL -C <dir>' is disallowed in this project.
Your CWD is already the dogear repo — drop the '-C <dir>' and retry
as plain '$TOOL <subcommand> ...'. The existing allowlist covers the
plain form so it will run without a permission prompt.
EOF
  exit 2
fi

exit 0