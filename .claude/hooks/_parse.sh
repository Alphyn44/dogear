#!/usr/bin/env bash
# Shared helpers for Claude Code hook scripts.
#
# Provides `hook_extract` to read a single field from the JSON Claude Code pipes
# to a hook on stdin. Hooks receive payloads shaped like:
#
#   { "tool_name": "Edit",
#     "tool_input": { "file_path": "/abs/path.ts", ... } }
#
# Usage from a hook script:
#
#   HOOK_INPUT=$(cat)
#   FILE_PATH=$(hook_extract "$HOOK_INPUT" tool_input.file_path)
#   CMD=$(hook_extract "$HOOK_INPUT" tool_input.command)
#
# Parser order: a real Python (probed with `import json`, so the Windows
# Microsoft Store stub at /c/Users/.../WindowsApps/python3 is rejected), then
# the `py` launcher, then a sed fallback. The sed fallback handles
# `tool_input.<field>` for unescaped string values, which covers every
# payload shape these hooks care about.

# Cache the probed Python binary across calls in the same shell invocation.
: "${_HOOK_PYBIN:=}"
: "${_HOOK_PYBIN_PROBED:=}"

_hook_find_python() {
  if [ -n "$_HOOK_PYBIN_PROBED" ]; then
    [ -n "$_HOOK_PYBIN" ]
    return $?
  fi
  _HOOK_PYBIN_PROBED="yes"

  local candidate
  for candidate in python3 python "py -3" py; do
    # Word-split intentionally so "py -3" runs as `py -3 -c "..."`.
    # shellcheck disable=SC2086
    if $candidate -c "import json,sys;sys.exit(0)" >/dev/null 2>&1; then
      _HOOK_PYBIN="$candidate"
      return 0
    fi
  done
  return 1
}

# Python script used for extraction. Kept as a single-quoted string so bash
# doesn't try to expand anything inside it.
_HOOK_PYSCRIPT='
import json, sys
keys = sys.argv[1].split(".")
try:
    cur = json.load(sys.stdin)
    for key in keys:
        if isinstance(cur, dict):
            cur = cur.get(key, "")
        else:
            cur = ""
            break
    if isinstance(cur, (dict, list)):
        cur = ""
    print(cur)
except Exception:
    pass
'

hook_extract() {
  local payload="$1"
  local path="$2"

  if _hook_find_python; then
    # shellcheck disable=SC2086
    printf '%s' "$payload" | $_HOOK_PYBIN -c "$_HOOK_PYSCRIPT" "$path"
    return
  fi

  # sed fallback. Only supports tool_input.<field>; good enough for file_path
  # and command, which are the only paths these hooks need.
  local field
  field="${path##*.}"
  printf '%s' "$payload" \
    | sed -nE "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"((\\\\.|[^\"\\\\])*)\".*/\1/p" \
    | head -n 1
}
