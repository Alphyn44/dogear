#!/usr/bin/env bash
# PostToolUse hook: auto-format with Prettier after Claude edits a file, and
# mark the turn dirty so the Stop hook knows to typecheck.
#
# Trigger: PostToolUse with matcher "Edit|Write|MultiEdit".
# Behavior: if the edited file has a Prettier-managed extension and Prettier is
# installed, run `npx --no-install prettier --write` on it. Always exits 0 —
# a formatter must never block a turn.
#
# Scope is the whole repo, not a frontend/ subdirectory — dogear is TypeScript
# top to bottom.
#
# Intentionally excludes .md and .yml — Prettier reformats those aggressively
# in ways that produce noisy diffs on review. This file, CLAUDE.md, and the
# brief stay hand-formatted.

set -u

# shellcheck source=./_parse.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_parse.sh"

HOOK_INPUT="$(cat)"
FILE_PATH="$(hook_extract "$HOOK_INPUT" tool_input.file_path)"

[ -z "$FILE_PATH" ] && exit 0

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.css|*.json) ;;
  *) exit 0 ;;
esac

[ -f "$FILE_PATH" ] || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$SCRIPT_DIR/../..}"

# Never format inside dependency or build output, even if a tool hands us a
# path there.
NORMALIZED="${FILE_PATH//\\/\/}"
case "$NORMALIZED" in
  */node_modules/*|*/dist/*|*/.dogear/*) exit 0 ;;
esac

# Mark this turn as touching TypeScript. The Stop hook reads this marker to
# decide whether to typecheck, so verification only fires on turns where Claude
# actually edited .ts/.tsx. Other Prettier-managed extensions (.css, .json) get
# formatted but don't trigger a typecheck.
case "$FILE_PATH" in
  *.ts|*.tsx|*.mts|*.cts)
    touch "$PROJECT_DIR/.claude/.turn-ts-dirty" 2>/dev/null || true
    ;;
esac

# Silent skip until Prettier is actually installed — this hook must be safe to
# land before the first npm install.
[ -d "$PROJECT_DIR/node_modules/prettier" ] || exit 0
command -v npx >/dev/null 2>&1 || exit 0

if ! (cd "$PROJECT_DIR" && npx --no-install prettier --write --log-level=warn "$FILE_PATH"); then
  echo "[prettier-format] prettier failed for $FILE_PATH" >&2
fi

exit 0
