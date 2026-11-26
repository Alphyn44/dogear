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
# Parser order: node, then a sed fallback. The sed fallback handles
# `tool_input.<field>` for unescaped string values, which covers every payload
# shape these hooks care about.
#
# Why node and not Python: dogear cannot be developed without node, so it is
# always on PATH where these hooks run, and it needs no probe. Python did: on
# Windows `python3` is usually the Microsoft Store stub, which fails only after a
# full ~160ms start, so every hook paid for a failed probe, a successful probe and
# the extraction itself, three interpreter starts, about 500ms of each hook's
# ~575ms. Node starts in ~70ms. Measured, not assumed.
#
# Two output differences from the Python version, both deliberate: a JSON boolean
# prints as `true`/`false` rather than `True`/`False` (stop-verify.sh accepts
# both), and JSON null prints as an empty string rather than `None`.

# Node script used for extraction. Kept as a single-quoted string so bash doesn't
# try to expand anything inside it. `node -e <script> <path>` puts <path> in
# process.argv[1].
_HOOK_NODESCRIPT='
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    let cur = JSON.parse(input);
    for (const key of process.argv[1].split(".")) {
      const isMap = cur !== null && typeof cur === "object" && !Array.isArray(cur);
      cur = isMap && Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : "";
    }
    if (cur === null || typeof cur === "object") cur = "";
    process.stdout.write(String(cur) + "\n");
  } catch {}
});
'

hook_extract() {
  local payload="$1"
  local path="$2"

  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e "$_HOOK_NODESCRIPT" "$path"
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
