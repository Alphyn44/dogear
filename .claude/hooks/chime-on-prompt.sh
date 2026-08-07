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

# Python is required for reliable JSON settings parsing. Fail open (silent)
# if unavailable — the project's other hooks already depend on Python, so
# this branch is rarely hit.
if ! _hook_find_python; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

decision="$(
  CMD_TO_CHECK="$CMD" \
  PROJECT_DIR="$PROJECT_DIR" \
  HOME_DIR="${HOME:-${USERPROFILE:-}}" \
  $_HOOK_PYBIN - <<'PYEOF'
import json, os, sys

cmd = os.environ.get("CMD_TO_CHECK", "")
project = os.environ.get("PROJECT_DIR", "")
home = os.environ.get("HOME_DIR", "")

settings_files = [
    os.path.join(project, ".claude", "settings.json"),
    os.path.join(project, ".claude", "settings.local.json"),
    os.path.join(home, ".claude", "settings.json"),
]

def parse(pattern):
    """Bash(...) → (kind, value) or None for non-Bash patterns."""
    if not (pattern.startswith("Bash(") and pattern.endswith(")")):
        return None
    body = pattern[5:-1]
    if body.endswith(":*"):
        return ("prefix", body[:-2])
    if body.endswith(" *"):
        return ("prefix", body[:-2])
    if body.endswith("*"):
        return ("prefix", body[:-1].rstrip(":"))
    return ("exact", body)

def is_match(cmd, parsed):
    kind, val = parsed
    if kind == "exact":
        return cmd == val
    # prefix: empty matches everything; otherwise command must equal val or
    # start with val + " " (so "git" doesn't match "git-foo").
    if val == "":
        return True
    return cmd == val or cmd.startswith(val + " ")

allow, deny = [], []
for path in settings_files:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        continue
    perms = (data.get("permissions") or {})
    for p in (perms.get("allow") or []):
        parsed = parse(p)
        if parsed is not None:
            allow.append(parsed)
    for p in (perms.get("deny") or []):
        parsed = parse(p)
        if parsed is not None:
            deny.append(parsed)

for p in deny:
    if is_match(cmd, p):
        print("silent")
        sys.exit(0)

for p in allow:
    if is_match(cmd, p):
        print("silent")
        sys.exit(0)

print("chime")
PYEOF
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
