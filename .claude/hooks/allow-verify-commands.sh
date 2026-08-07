#!/usr/bin/env bash
# PreToolUse(Bash): auto-approve read-only VERIFICATION commands (typecheck /
# test / lint / build) so Claude can confirm work still passes without a
# permission prompt — including the compound (`a && b`) and quoted-arg
# (`--reporter='x|y'`) forms that the built-in prefix allowlist can't match.
#
# Safety model (why auto-approving here is safe):
#   - Quoted spans are stripped BEFORE scanning for shell operators, so a `|`
#     or `;` inside an argument is never mistaken for a real operator.
#   - We ABSTAIN (exit 0, no decision — normal flow / other hooks decide) on any
#     construct that could smuggle in a second command: `;`, `$(`, backtick, a
#     background `&`, or a redirect (`>`/`<`). We only ever *approve*, never
#     approve-around-a-danger.
#   - Every operator-separated segment must lead with an allowlisted verify
#     verb. One unknown segment → abstain.
#   - block-destructive-bash.sh runs AHEAD of this hook and still vetoes
#     anything dangerous (a deny from any hook wins over this allow). That is
#     what makes the `npx --no-install` entry below safe: bare `npx` is already
#     dead by the time we get here.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_parse.sh"

HOOK_INPUT="$(cat)"
CMD="$(hook_extract "$HOOK_INPUT" tool_input.command)"
[ -z "$CMD" ] && exit 0

# 0. Excise `npm --prefix <dir>` / `-w <workspace>` (quoted or bare) as a unit,
#    so workspace-scoped npm segments reduce to `npm run ...` regardless of the
#    (space-containing, usually quoted) path — done BEFORE quote-stripping so
#    the path and its flag disappear together.
CMD="$(printf '%s' "$CMD" | sed -E "s/(--prefix|--workspace|-w)[[:space:]]+(\"[^\"]*\"|'[^']*'|[^[:space:]]+)//g")"

# 0b. Drop a redundant `2>&1` stream-merge — the harness captures stderr anyway,
#     so it shouldn't force a prompt on an otherwise-approvable verify command.
CMD="$(printf '%s' "$CMD" | sed -E 's/2>&1//g')"

# 1. Strip single- and double-quoted spans so operators inside them don't count,
#    then collapse whitespace runs to single spaces — removing a flag leaves
#    double spaces that would break the token/substring checks below.
stripped="$(printf '%s' "$CMD" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g" | tr -s '[:space:]' ' ')"

# 2. Abstain on redirects, command substitution, or statement separators.
case "$stripped" in
  *';'* | *'$('* | *'`'* | *'>'* | *'<'* ) exit 0 ;;
esac

# 3. Break the command into segments on the legit operators && || | ; a leftover
#    single '&' after that is a background job — abstain.
segs="$(printf '%s' "$stripped" | sed -E 's/&&|\|\|/\n/g; s/\|/\n/g')"
case "$segs" in
  *'&'* ) exit 0 ;;
esac

verb_ok() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"   # trim leading whitespace
  case "$s" in
    # Read-only git inspection (mutations are caught by block-destructive-bash).
    "git status"*|"git diff"*|"git log"*|"git show"*|"git blame"*|"git ls-files"*|\
    "git rev-parse"*|"git describe"*|"git for-each-ref"*|"git reflog"*|\
    "git remote -v"*|"git worktree list"*) return 0 ;;
    # Output filters — only ever applied to another tool's output.
    "head "*|"head"|"tail "*|"tail"|"wc "*|"wc"|"sort "*|"sort"|"uniq "*|"uniq") return 0 ;;
    "node --version"|"node -v"|"npm --version"|"npm -v") return 0 ;;
  esac

  # npx is restricted to --no-install by block-destructive-bash.sh, so anything
  # reaching here runs a binary already in node_modules — no network, no
  # fetch-and-execute. Approve the read-only verification binaries by name.
  case "$s" in
    "npx --no-install "*)
      case "$s" in
        *" tsc"*|*" vitest"*|*" eslint"*|*" prettier"*|*" tsup"*|*" attw"*|*" publint"*) return 0 ;;
      esac ;;
  esac

  # npm verification subcommands only. Anything that fetches, publishes, or
  # mutates package state is deliberately NOT auto-approved here (and is
  # separately blocked upstream).
  case "$s" in
    "npm "*)
      case "$s" in
        *install*|*" ci"*|*" exec"*|*dlx*|*publish*|*update*|*" add"*|*" link"*|*version*) return 1 ;;
      esac
      case "$s" in
        "npm ls"*|"npm list"*|"npm outdated"*|"npm why"*|"npm view"*|"npm audit"*) return 0 ;;
        *"run typecheck"*|*"run lint"*|*"run build"*|*"run format:check"*|\
        *"run check"*|*"run verify"*|*"run test"*|*" test "*|*" test") return 0 ;;
      esac ;;
  esac
  return 1
}

all_ok=true
while IFS= read -r seg; do
  [ -z "${seg//[[:space:]]/}" ] && continue
  if ! verb_ok "$seg"; then all_ok=false; break; fi
done <<EOF
$segs
EOF

if $all_ok; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"read-only verification command (typecheck/test/lint/build)"}}'
fi
exit 0
