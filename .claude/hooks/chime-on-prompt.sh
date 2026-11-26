#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash): chime when the command is NOT allowlisted —
# i.e., Claude Code is about to show a permission prompt.
#
# Reads .claude/settings.json, .claude/settings.local.json, and
# ~/.claude/settings.json at runtime so the matcher always reflects your
# current allowlist. No mirrored constants to drift.
#
# Mirrors Claude Code's literal prefix matching:
#   Bash(npm run:*)    → command must start with "npm run" (then space/end)
#   Bash(git status)   → command must equal "git status" exactly
#   Bash(npx vitest *) → command must start with "npx vitest "
#   Bash(*)            → matches anything
#
# Deny patterns short-circuit silently — denied commands are refused outright
# without a prompt, so a chime would be noise.
#
# Chime is backgrounded so the permission prompt isn't delayed by the ~2s
# audio playback.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_parse.sh
. "$SCRIPT_DIR/_parse.sh"

HOOK_INPUT="$(cat)"
CMD="$(hook_extract "$HOOK_INPUT" tool_input.command)"

if [ -z "$CMD" ]; then
  exit 0
fi

# node is required for the settings parsing below, as it is for hook_extract.
# Fail open (silent) if it is missing: a missing chime is the cheap failure.
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

decision="$(
  CMD_TO_CHECK="$CMD" \
  PROJECT_DIR="$PROJECT_DIR" \
  HOME_DIR="${HOME:-${USERPROFILE:-}}" \
  node - <<'JSEOF'
const fs = require("fs");
const path = require("path");

const cmd = process.env.CMD_TO_CHECK || "";
const project = process.env.PROJECT_DIR || "";
const home = process.env.HOME_DIR || "";

const settingsFiles = [
  path.join(project, ".claude", "settings.json"),
  path.join(project, ".claude", "settings.local.json"),
  path.join(home, ".claude", "settings.json"),
];

// Bash(...) -> [kind, value], or null for non-Bash patterns.
function parse(pattern) {
  if (typeof pattern !== "string") return null;
  if (!(pattern.startsWith("Bash(") && pattern.endsWith(")"))) return null;
  const body = pattern.slice(5, -1);
  if (body.endsWith(":*")) return ["prefix", body.slice(0, -2)];
  if (body.endsWith(" *")) return ["prefix", body.slice(0, -2)];
  if (body.endsWith("*")) return ["prefix", body.slice(0, -1).replace(/:+$/, "")];
  return ["exact", body];
}

// prefix: empty matches everything; otherwise the command must equal the value
// or start with value + " " (so "git" doesn't match "git-foo").
function isMatch([kind, val]) {
  if (kind === "exact") return cmd === val;
  if (val === "") return true;
  return cmd === val || cmd.startsWith(val + " ");
}

const allow = [];
const deny = [];
for (const file of settingsFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  const perms = (data && data.permissions) || {};
  for (const p of perms.allow || []) {
    const parsed = parse(p);
    if (parsed) allow.push(parsed);
  }
  for (const p of perms.deny || []) {
    const parsed = parse(p);
    if (parsed) deny.push(parsed);
  }
}

console.log(deny.some(isMatch) || allow.some(isMatch) ? "silent" : "chime");
JSEOF
)"

if [ "$decision" = "chime" ]; then
  # Distinct sound from chime.sh's tada.wav so you can tell "needs permission"
  # apart from "Claude finished" without looking. Sync is fine — Exclamation
  # is ~0.5s, barely a delay before the prompt appears.
  # Want a different sound? Swap the wav path below.
  powershell.exe -NoProfile -Command \
    "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Windows Exclamation.wav').PlaySync()" \
    >/dev/null 2>&1
fi

exit 0
