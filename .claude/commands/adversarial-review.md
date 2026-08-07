---
description: Fan out isolated skeptics that try to REFUTE the current diff; only findings that survive a majority vote are reported.
argument-hint: "[diff | staged | <base>..<head> | <PR#>]  (default: working diff vs main)"
---

You are running an **adversarial code review** of dogear. The goal is not to
praise the change — it is to *break* it. Findings only count if they survive
independent verification, so bias hard toward disconfirmation.

## Target

`$ARGUMENTS` selects what to review (default: the working diff vs `main`):
- empty or `diff` → `git diff main...HEAD` plus uncommitted changes
- `staged` → `git diff --cached`
- `<base>..<head>` → that range
- a bare number → GitHub PR `#<n>` (use `gh pr diff <n>`)

First, gather the diff and the touched files. Read enough surrounding code (via
CodeGraph — `codegraph_explore` — before grep/Read) that each reviewer sees the
blast radius, not just the patch.

## How to run it

1. **Fan out 3–4 independent reviewers in parallel** (one message, multiple
   `Agent` calls, `subagent_type: "Code Reviewer"`). Give each a **distinct
   lens** so they don't all find the same thing:
   - **Correctness/logic** — off-by-one, empty/partial-failure, error swallowing,
     wrong branch, an element that resolves to no source at all.
   - **Concurrency/state** — the queue write race above all: two dev servers
     appending at once, a cached queue read at server start, a temp filename
     that isn't pid-unique, a non-atomic rename. Also browser-vs-disk drift.
   - **Contract/interface** — signature drift, callers not updated, MCP tool
     schema changes, and any change to the on-disk queue shape that doesn't bump
     `version` or stays readable by an older reader.
   - **Domain invariants** — the Key Design Rules in `CLAUDE.md`: everything
     reachable through MCP, queue resolved from the git root, `apply: 'serve'`
     keeping dogear out of production builds, no React internals, zero network
     egress beyond localhost.
   Each reviewer is told: *your job is to REFUTE this change — produce concrete
   failure scenarios (inputs/state → wrong output/crash), not style notes.
   Default to "no bug found" unless you can name the trigger.* They see only the
   diff + repo, never this conversation.

2. **Verify survivors.** Collect all findings, dedupe by file+line, and for each
   candidate ask: is there a concrete input/state that triggers it, and does the
   surrounding code already prevent it? Drop anything you can't reproduce on
   paper. When in doubt, spawn one more skeptic to try to refute *that specific
   finding*; kill it if the skeptic wins.

3. **Report** survivors most-severe-first: file:line, one-sentence defect, the
   concrete failure scenario, and a suggested fix. If nothing survives, say so
   plainly — a clean adversarial pass is a real result, not a failure to try.

Do not fix anything unless asked — this command reports. For the heavyweight
cloud version, note `/code-review ultra` exists (multi-agent, billed).
