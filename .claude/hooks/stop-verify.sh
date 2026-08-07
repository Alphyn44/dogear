#!/usr/bin/env bash
# Stop hook: fast per-turn gate for a TypeScript monorepo.
#
# Trigger: Stop (fires when Claude finishes a turn).
# Behavior:
#   - Read the marker file written by the PostToolUse formatter during this turn:
#       .claude/.turn-ts-dirty   → Claude edited a .ts/.tsx file
#   - If set: run the repo's `typecheck` script, if one exists.
#   - Read-only turns leave no marker and skip everything.
#   - The marker is deleted unconditionally so the next turn starts clean, even
#     if verification fails.
#
# Why this is deliberately light: the per-turn job is only to confirm the tree
# still typechecks — cheap, and it keeps iteration fast. The heavier suite
# (lint, vitest, build) belongs in a `verify`/`preflight` script run before a
# commit, NOT on every turn.
#
# Why markers instead of `git status --porcelain`: porcelain reflects the
# cumulative state of the working tree, so any pending edit from earlier in the
# day made every turn (including read-only ones like "explain this function")
# run verification. Markers make it truly per-turn.
#
# EVERY absence is a silent skip, never a failure. This repo starts empty — no
# package.json, no node_modules, no scripts — and a Stop hook that errors on an
# empty repo would break every single turn. Only a real typecheck failure exits
# non-zero.

set -u

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 0

TS_MARKER="$PROJECT_DIR/.claude/.turn-ts-dirty"

[ -f "$TS_MARKER" ] || exit 0
rm -f "$TS_MARKER"

# Nothing to verify until the project actually exists. M0 creates these.
if [ ! -f "$PROJECT_DIR/package.json" ]; then
  exit 0
fi

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "[stop-verify] node_modules missing — skipping typecheck. Run \`npm install\`." >&2
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[stop-verify] npm not on PATH; skipping typecheck." >&2
  exit 0
fi

echo ""
echo "[stop-verify] TypeScript changes detected — typechecking..."
echo "[stop-verify] \$ npm run typecheck --if-present"

# --if-present exits 0 when no `typecheck` script is defined, so this stays a
# no-op until the script exists rather than failing loudly on a young repo.
if npm run typecheck --if-present; then
  echo "[stop-verify] OK."
  exit 0
fi

echo ""
echo "[stop-verify] ============================================"
echo "[stop-verify] FAILED: npm run typecheck"
echo "[stop-verify] ============================================"
exit 1
