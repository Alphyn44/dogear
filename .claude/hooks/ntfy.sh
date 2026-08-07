#!/usr/bin/env bash
# Stop hook: push a notification when Claude finishes a turn.
#
# Trigger: Stop only. Stop fires when a turn ends — whether Claude is "done"
# or asking the user a question. Tool-permission prompts pause mid-turn and
# do NOT fire Stop, so they are naturally excluded.
#
# Priority: high → ntfy mobile app plays the default notification sound.
# (Default priority delivers silently on most devices.) Bump to "urgent" for
# the long-ringtone-plus-vibration treatment.
#
# THE TOPIC IS NOT IN THIS FILE. An ntfy topic is a shared secret: anyone who
# knows the string can read your notifications or post to them. It lives in
# .claude/ntfy.url, which is gitignored — so this script stays safe to commit
# even in a public repo.
#
# Setup: create .claude/ntfy.url containing a single line, e.g.
#   https://ntfy.sh/some-hard-to-guess-topic
#
# No file, or an empty one → this hook does nothing, silently. That keeps the
# repo clonable by anyone without a broken Stop hook.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
URL_FILE="${CLAUDE_PROJECT_DIR:-$SCRIPT_DIR/../..}/.claude/ntfy.url"

[ -f "$URL_FILE" ] || exit 0

# Strip whitespace/newlines — a URL never contains any, and a trailing newline
# from an editor would otherwise become part of the request target.
NTFY_URL="$(tr -d '[:space:]' < "$URL_FILE")"
[ -n "$NTFY_URL" ] || exit 0

curl -fsS \
  -H "Title: dogear" \
  -H "Priority: high" \
  -H "Tags: white_check_mark" \
  -d "Claude is done" \
  "$NTFY_URL" >/dev/null 2>&1

exit 0
