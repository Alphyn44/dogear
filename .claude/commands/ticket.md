---
description: Start a dogear ticket the right way — read, verify against the brief and the code, GRILL before planning, then plan → implement → verify. Never skips the interview or commits.
argument-hint: "<ticket path, issue number, story ID like C2, or pasted text>"
---

You are starting a ticket. Follow dogear's workflow (from CLAUDE.md) in order — do
**not** shortcut to code, and do **not** skip the grill even if the ticket looks
obvious.

## The ticket

`$ARGUMENTS` is the ticket — a file path, a GitHub issue number, a user-story ID from
the brief (`A1`, `C2`, `D3`…), or pasted text.

- **Path** — read it.
- **Issue number** — `gh issue view <n>`.
- **Story ID** — resolve it to its issue first with
  `gh issue list --search "<ID> in:title"`. Every brief story is tracked as an issue
  titled `<ID> — <short title>`, so this returns exactly one match. Read that issue,
  *then* the brief section. The brief is the spec, but the issue carries the scoping
  notes and the dependency state — going straight to the brief skips both.
- **Empty** — ask me for it before doing anything else.

If the ticket resolved to an issue, check its **blocked by** list before planning. If a
blocker is still open, say so and ask whether we're starting anyway. Don't discover it
in Step 3.

## Step 1 — Read + orient (no code yet)

- Read the ticket fully.
- **Read the section of `dogear-brief.md` it touches.** The brief is the source of
  truth for design decisions: the data contracts, the milestone ordering, and the
  Decisions log explaining why each fork went the way it did. A ticket that
  contradicts the brief is a conflict to surface, not a spec to follow.
- Confirm **what already exists** in the code — the ticket is intent, not ground
  truth. If this repo is indexed (a `.codegraph/` directory exists), use
  `codegraph_explore`; otherwise Read/Grep/Glob. Note the blast radius.
- Check the **Decisions log** and **Still open** sections of the brief. If the ticket
  reopens something already settled, say so and ask whether we're changing the
  decision — don't silently re-litigate it in code.

## Step 2 — GRILL me (the step you must not skip)

Interview me until two engineers reading your notes would build the same thing. Walk
every ambiguous decision branch and ask — don't assume:

- **Naming** — packages, types, functions, fields; if two reasonable names exist, ask.
- **Interface shape** — signatures, return types, error semantics.
- **Edges** — missing input, partial failure, empty result, a malformed queue file,
  two dev servers writing at once, a browser with no source attribute anywhere.
- **Scope** — what's in this ticket vs deferred; if it hints at adjacent work, ask.
- **Conflicts** — anything that fights the brief or existing code (from Step 1).

Use the `AskUserQuestion` tool for the real forks — options plus a recommendation. I
drive the decisions. Keep going until the answers are concrete. I'd rather answer 15
questions than debug one bad assumption.

## Step 3 — Plan (get approval before code)

Outline the files, types, interfaces, and tests. Name the specific functions and
utilities to reuse, with paths. Call out which design rules from CLAUDE.md apply —
in particular:

- **MCP is the product.** Does any part of this work only with the Claude Code hook?
  If so, that's a design error; say so.
- **Queue writes** — git-root resolution, pid-suffixed temp file, read-modify-write.
- **Production safety** — does this touch anything that could survive into a build?
- **No React internals.**

Present the plan and **wait for my approval**.

## Step 4 — Implement + test

- Write the code; match the surrounding style. Explain non-obvious choices briefly —
  Vite plugin hook ordering, AST-transform decisions, MCP protocol details.
- Write tests for the new behavior; fix any existing tests your change breaks and
  explain why they broke.
- If you must stub, say so explicitly and add `// TODO(dogear): …`.
- **Do not run `npm install`.** If the ticket needs a new dependency, stop and ask me
  to install it, and say exactly which package and why.

## Step 5 — Verify

- Run the repo's actual verification scripts — check `package.json` for what exists
  rather than assuming a target. Early on that may be only `npm run typecheck`.
- Don't say "it should work." Show what ran and what passed, and flag anything you
  could not verify.
- For anything touching the browser half, tell me exactly what to click to see it
  working. The overlay is not unit-testable end to end.

## Step 6 — Docs + hand-off

- Update `dogear-brief.md` **only** if this ticket changed a design decision — add or
  amend the Decisions log entry. Most tickets won't.
- Update `CLAUDE.md` only if architecture, commands, or working rules changed. If this
  is the ticket that creates `package.json` and the first scripts, fill in the
  Commands section, which currently says there are none.
- **Do not commit** — I review and commit manually. End with a paste-ready commit
  message (headline + markdown body + the co-author trailer).
