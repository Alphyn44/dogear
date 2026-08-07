#!/usr/bin/env bash
# Stop hook: fast per-turn gate for a TypeScript monorepo.
#
# Trigger: Stop (fires when Claude finishes a turn).
# Behavior:
#   - Read the marker file written by the PostToolUse formatter during this turn:
#       .claude/.turn-ts-dirty   → Claude edited a .ts/.tsx file
#   - If set: run the repo's `typecheck` script, then `test`, if they exist.
#   - Read-only turns leave no marker and skip everything.
#   - The marker is deleted unconditionally so the next turn starts clean, even
#     if verification fails.
#
# WHY EXIT 2 AND NOT EXIT 1 — this is the difference between a gate and a notice.
# Claude Code treats Stop-hook exit codes three different ways:
#     exit 0  → stdout reaches the transcript only. Claude sees nothing.
#     exit 1  → stderr reaches the USER. Claude sees nothing, and the turn ends.
#     exit 2  → stderr is fed BACK to Claude, and Claude is blocked from stopping.
# The original version exited 1, which meant a broken typecheck printed into the
# terminal and the turn ended anyway — catching nothing unless a human happened to
# be reading. Only exit 2 puts the failure back into the session that caused it.
#
# WHY THE LOOP GUARD: exit 2 makes Claude continue, which eventually produces
# another Stop, which runs this hook again. Claude Code sets `stop_hook_active` to
# true on that second pass; bailing on it is what stops a permanently-broken
# typecheck from trapping the session in a loop it cannot exit. The
# .turn-verify-blocked marker is a fallback for machines where _parse.sh finds no
# Python and drops to its sed path, which can only read string fields and would
# silently return nothing for a JSON boolean.
#
# Note the deliberate consequence: the turn where Claude FIXES the failure is not
# re-verified by this hook, because stop_hook_active is true throughout it. That is
# the correct trade — a hook that cannot be escaped is worse than one that checks
# once. `npm run verify` and CI are what confirm the fix.
#
# WHY TYPECHECK AND TEST BUT NOT BUILD: the per-turn job is "does it still compile
# and still pass". Build, format:check, and the example's typecheck are slower and
# belong in `npm run verify` before a commit, not on every turn.
#
# Why markers instead of `git status --porcelain`: porcelain reflects the
# cumulative state of the working tree, so any pending edit from earlier in the
# day made every turn (including read-only ones like "explain this function")
# run verification. Markers make it truly per-turn.
#
# EVERY absence is a silent skip, never a failure. A missing package.json,
# node_modules, or npm exits 0 — only a real verification failure exits 2.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_parse.sh
. "$SCRIPT_DIR/_parse.sh"

HOOK_INPUT="$(cat)"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 0

TS_MARKER="$PROJECT_DIR/.claude/.turn-ts-dirty"
BLOCK_MARKER="$PROJECT_DIR/.claude/.turn-verify-blocked"

# --- Loop guard. Must come before anything that can exit 2. -------------------
STOP_HOOK_ACTIVE="$(hook_extract "$HOOK_INPUT" stop_hook_active)"
case "$STOP_HOOK_ACTIVE" in
  true | True | TRUE)
    rm -f "$BLOCK_MARKER" "$TS_MARKER"
    exit 0
    ;;
esac

if [ -f "$BLOCK_MARKER" ]; then
  rm -f "$BLOCK_MARKER" "$TS_MARKER"
  exit 0
fi

# --- Did this turn touch TypeScript at all? -----------------------------------
[ -f "$TS_MARKER" ] || exit 0
rm -f "$TS_MARKER"

# --- Silent skips: nothing to verify yet. -------------------------------------
if [ ! -f "$PROJECT_DIR/package.json" ]; then
  exit 0
fi

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "[stop-verify] node_modules missing — skipping. Run \`npm install\`." >&2
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[stop-verify] npm not on PATH; skipping." >&2
  exit 0
fi

# --- Verify. ------------------------------------------------------------------
echo ""
echo "[stop-verify] TypeScript changed — typechecking and testing..."

# --if-present exits 0 when the script isn't defined, so this stays a no-op on a
# repo that hasn't grown that script yet rather than failing loudly.
FAILED=""
if ! npm run typecheck --if-present; then
  FAILED="npm run typecheck"
elif ! npm test --if-present; then
  FAILED="npm test"
fi

if [ -z "$FAILED" ]; then
  rm -f "$BLOCK_MARKER"
  echo "[stop-verify] OK."
  exit 0
fi

touch "$BLOCK_MARKER" 2>/dev/null || true

# stderr, because that is specifically what exit 2 delivers back to Claude.
{
  echo ""
  echo "[stop-verify] ============================================"
  echo "[stop-verify] FAILED: $FAILED"
  echo "[stop-verify] ============================================"
  echo ""
  echo "This turn edited TypeScript and left the tree failing. Re-run the command"
  echo "above, read the actual output, and fix the cause."
  echo ""
  echo "If the failure is pre-existing and unrelated to this turn, say so plainly"
  echo "and show the evidence — do not work around it or silence the check."
} >&2

exit 2
