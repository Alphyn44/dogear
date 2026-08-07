#!/usr/bin/env bash
# PreToolUse(Bash): block bash invocations of search/read tools when a
# dedicated Claude Code tool exists. The agent has Grep/Glob/Read tools
# that are faster, prompt-free, and don't suffer from shell-quoting,
# path-escape, or pipeline failure modes.
#
# Only the LEADING token is checked. Piping output through head/tail/grep
# (e.g. `npm test | tail -50`) is fine — that's filtering another
# tool's output, not "searching the codebase."

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_parse.sh"

HOOK_INPUT="$(cat)"
CMD="$(hook_extract "$HOOK_INPUT" tool_input.command)"
[ -z "$CMD" ] && exit 0

# NOTE: `cat` is deliberately NOT blocked. A blanket ban fires mostly on
# legitimate one-line config peeks and multi-file reads, costing a retry each
# time. The Read tool is still preferred — prompt-free, no shell-quoting or
# path-escape hazards — but that preference doesn't need enforcement. The
# load-bearing rules below (bare grep/find, .bin/ invocation, PowerShell
# cmdlets) stay.

# Direct invocation of node_modules/.bin/<tool> bypasses the npm wrapper and
# costs a permission prompt. Tested against the whole command (not LEADING)
# because the leading token is often a quoted absolute path with spaces, and
# LEADING extraction is whitespace-only — it doesn't honor quotes.
if [[ "$CMD" =~ node_modules[/\\]\.bin[/\\] ]]; then
  cat >&2 <<EOF
Blocked: direct invocation of a node_modules/.bin/ binary bypasses the npm
wrapper and costs a permission prompt. Use 'npm run <script>' / 'npm test',
or 'npx --no-install <bin>' — both are auto-approved for the verification
tools. Pass args after '--', e.g. 'npm test -- --reporter=basic'.
EOF
  exit 2
fi

# First whitespace-delimited token, leading whitespace stripped.
LEADING="${CMD#"${CMD%%[![:space:]]*}"}"
LEADING="${LEADING%%[[:space:]]*}"

# Leading token looks like a PowerShell cmdlet (Verb-Noun PascalCase, e.g.
# Get-ChildItem, Select-Object)? The Bash tool runs bash (Git Bash), not
# PowerShell, so these always fail — and without this they'd cost a permission
# prompt BEFORE failing. Auto-denying here removes the prompt entirely and
# nudges toward the dedicated tools. Bash commands are lowercase and never
# match this shape, so the false-positive surface is negligible.
if [[ "$LEADING" =~ ^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$ ]]; then
  cat >&2 <<EOF
Blocked: '$LEADING' is a PowerShell cmdlet, but the Bash tool runs bash, not
PowerShell. Use the Glob/Grep/Read tools for listing/searching/reading, or a
POSIX bash command. If you truly need PowerShell, ask the user to run it.
EOF
  exit 2
fi

case "$LEADING" in
  grep)          suggest="To locate or understand CODE, call codegraph_explore first if this repo is indexed (verbatim source + callers in one shot). Otherwise use the Grep tool (pattern, glob, path, output_mode)." ;;
  find)          suggest="To find CODE symbols or definitions, call codegraph_explore first if this repo is indexed. For file-path globbing, use the Glob tool (pattern, path)." ;;
  head|tail)     suggest="Use the Read tool (file_path, offset, limit). Piping another command's output through head/tail is fine — only the LEADING token is checked." ;;
  xargs|sed|awk) suggest="Compose Grep + Read + Edit instead of shell pipelines." ;;
  *)             exit 0 ;;
esac

cat >&2 <<EOF
Blocked: '$LEADING' as a leading bash command is disallowed in this project.
$suggest
Dedicated tools don't require permission prompts and avoid shell-quoting,
path-escape, and pipeline failure modes. If you genuinely need the shell
form, ask the user to run it manually.
EOF
exit 2
