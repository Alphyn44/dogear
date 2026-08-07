#!/usr/bin/env bash
# PreToolUse(Bash): block the `<cmd> 2>&1 | head/tail` output-trimming pattern.
# The Bash tool already captures stderr AND truncates long output, so the
# stream-merge + pager add nothing — and worse, the `2>&1` redirect forces a
# permission prompt on a command whose bare form is already allowlisted
# (e.g. `npm test 2>&1 | head -40` prompts; `npm test` does not).
# Nudge back to the bare command, which auto-approves.
#
# Deliberately narrow: only `2>&1` IMMEDIATELY feeding a pipe is caught. A file
# redirect (`... 2>&1 > out.log`) or a standalone `2>&1` is left alone.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_parse.sh"

HOOK_INPUT="$(cat)"
CMD="$(hook_extract "$HOOK_INPUT" tool_input.command)"
[ -z "$CMD" ] && exit 0

# ERE via an unquoted variable (the recommended way to feed [[ =~ ]] a regex).
# `>` and `&` are literal in ERE; `[|]` matches a literal pipe.
pat='2>&1[[:space:]]*[|]'
if [[ "$CMD" =~ $pat ]]; then
  cat >&2 <<'EOF'
Blocked: `... 2>&1 | head/tail` is redundant in this harness. The Bash tool
already captures stderr and truncates long output, so the stream-merge + pager
add nothing — and the `2>&1` redirect forces a permission prompt on a command
whose bare form is already allowlisted.

Run the bare command instead:
  npm run typecheck       (not  npm run typecheck 2>&1 | head -40)
  npm test                (not  npm test 2>&1 | tail -50)

If you genuinely need only the last N lines of a noisy stream, ask the user to
run it manually.
EOF
  exit 2
fi

exit 0
