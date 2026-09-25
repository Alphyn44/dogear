---
description: Audit a bloated dogear milestone. Explain every issue in plain language, classify it, verify its claims against the code and the brief, then move, defer or split what does not belong. Never closes anything, never commits.
argument-hint: "<milestone number, name, or URL>"
---

You are triaging a dogear milestone (`Alphyn44/dogear`) that has grown past what it can
deliver. The output is a decision, not a summary: each open issue either **earns its place**,
**moves**, **defers**, or **splits**.

**A milestone description is a question.** Every issue in it either answers that question
or does not. Good work that answers a *different* question is in the wrong milestone; that
is the whole test, and it is not a judgement about the work's value.

**An issue is a claim, not an instruction.** That applies to placement too: an issue that
reads like a README edit but, per the code, needs a new published package is mis-sized, and
size changes where it belongs.

## The milestone

`$ARGUMENTS` resolves to one milestone: a number, a title, or a `github.com/.../milestone/N`
URL. Empty: list the milestones with their counts and ask which one.

`gh` has no milestone subcommand, and `gh api` is hook-blocked except for this repository's
milestones, **endpoint first**:

```bash
gh api repos/Alphyn44/dogear/milestones -X GET -f state=all --jq '.[] | "\(.number)\t\(.state)\t\(.title)\topen=\(.open_issues) closed=\(.closed_issues)"'
```

## Step 1: Read the yardstick, and the destinations

Read the target milestone's **description** and quote its question back before you start.
That is the standard every call is measured against. **A pre-M8 milestone is a one-line
summary with no membership rule**; for those, the yardstick is its brief epic under
**Features and user stories** and its row in the **Build order** table.

Then read the description of **every milestone you might move something to**. Their
semantics differ and are not interchangeable. The one destination that is not a milestone:
**deferring means no milestone**, with the brief's **Later, maybe** naming the work (or
**Still open**, for an unanswered question). "Later, maybe" means *may never*; a later
milestone means *wanted, but not next*. Putting wanted work in Later, maybe destroys that
distinction. Never assume a destination; read what it says it is.

## Step 2: Read everything, including the comments and the brief

For every **open** issue in the milestone:

```bash
gh issue view <n> --repo Alphyn44/dogear --json number,title,body,labels,milestone,comments,blockedBy,blocking
```

**Read the comments.** They routinely carry corrections that invert an issue's scope: a
later audit finding the feature half-built, or the filed approach contradicting a
Decisions-log entry. An issue body that has never been revised is the least reliable thing in
the milestone.

**Read the brief story each issue tracks** (its title's ID). The brief is the spec and the
issue the tracker, so criteria that differ between the two are a finding in their own right,
and the brief is the one that is right until someone decides otherwise.

Also list the **closed** issues. You need them for Step 6 (coverage), and a closed issue
often already delivered something an open one still claims is missing.

## Step 3: Audit the claims that change placement (blocking)

You cannot fully audit fifteen issues. Audit **the claims that would change the decision**,
and for each issue exactly these:

| Question | Why it changes placement |
|---|---|
| **Is it already built?** | Partly-built work is smaller than filed, and sometimes already done |
| **Is it the size it looks?** | Anything that needs a new published package, a new runtime dependency or a change to a data contract in the brief is bigger than its title suggests |
| **Does the mechanism work how the issue says?** | An inverted premise can flip what the issue is *for* |
| **Do its `blockedBy` edges exist, and are they real?** | A blocked issue cannot be scheduled anywhere; a loose edge blocks closing an issue that is not really blocked |
| **Does it contradict the brief?** | A Decisions-log entry or a Non-goal it runs into is a ruling to revisit, not work to schedule |

This repo is indexed: use `codegraph_explore` first, then Read the specific lines when a
verdict is close. **Cite `file.ts:line`.** An unsourced verdict is not one. The vocabulary:

- `✅ Confirmed`: the code says what the claim says.
- `⚠️ Stale`: it was true once, or is partly true; say which part.
- `❌ Wrong`: the code says otherwise.
- `❓ Unverifiable`: the repo cannot answer it.

Two findings from a real pass, as calibration for how much this step matters. Both came from
checking an outside review of `dogear init` against the code:

- *"`--agent=claude` stops init writing more than you'd expect."* Half right. It stops the
  VS Code MCP config, because it replaces detection; it does not stop the agent-instructions
  section, which is written for every wired agent whichever agent that is.
- *"`dogear-queue` isn't published, so a new package would need it published."* Moot. The
  `noExternal` inlining pattern every package already uses covers a new one for free.

Neither was findable in the text that made the claim. Both changed what got filed.

## Step 4: Write the brief

One entry per open issue. This is the artefact you present, and it is what makes the call
obvious rather than arguable.

```
### #N — <title> · <kind> · <blocked by #X, or "no blockers">

<3 to 4 sentences, plain language: what this is and what it is for. No jargon, no
implementation detail unless the mechanism IS the point.>

**Today:** <the actual current experience: what a developer using dogear hits right now.>
**After:** <the experience when this ships.>
**Type:** <classification>   **Verdict:** <keep | move → X | defer | split>
```

**Today and After are not optional and not decoration.** An issue where Today is hard to
write usually turns out to be speculative; an issue where Today and After read almost the
same is an improvement, not a feature. The framing does most of the sorting for you.

### Classification

| Type | Means | Default disposition |
|---|---|---|
| **Bug** | Behaves differently than the docs say | **Stays.** Wrong behaviour is not a roadmap item |
| **Gap** | Built but unreachable, or the docs promise what the code cannot do | **Usually stays.** Cheap, and it is a broken promise today |
| **Improvement** | Works; could work better | **Movable.** The most common thing in a bloated milestone |
| **Feature** | Does not exist at all | **Movable**, unless the milestone's question needs it |
| **Decision** | The deliverable is a ruling, not code | **Answer it or move it.** Never schedule around it |

Classification predicts placement. A bloated milestone is almost always carrying
Improvements and Features that answer a *later* question, and the Bugs and Gaps are the
cheap, high-value residue worth keeping.

## Step 5: Check dependencies before you move anything

Build the dependency edges across **all** milestones, not just this one, from each issue's
`blockedBy` and `blocking`, plus any "sequence after #N" a Note or the brief's delivery
ordering states.

Then verify no proposed move **inverts a build order**: a consumer must not land in an
earlier milestone than its producer. This is the failure a per-issue review cannot see,
because each move looks fine alone.

Moving an issue that others depend on means **moving the block together**, or saying plainly
that the dependency is being broken and what it costs.

## Step 6: Check coverage, then propose

Before proposing: does what **remains** (plus what already **closed**) still answer the
milestone's question? If removing an issue leaves the exit test unsatisfiable, either it
stays or the description is wrong; say which.

Then look for **splits**. A bloated issue is rarely wholly misplaced; more often it has a
small keep-worthy core and a speculative remainder. Splitting beats moving wholesale when:

- part of it is a Gap (cheap, broken today) and the rest is a Feature
- its parts live in different packages and cannot share a session
- one part is blocked on a decision and the rest is not

**Splitting a story takes a new story ID, and the brief moves first**: the remainder becomes
its own entry in the epic, and the original entry's criteria shrink to match what stays.

Present the brief, then use `AskUserQuestion` for the calls, options with a
**recommendation first**. Include "keep it here"; do not assume everything flagged should
move.

**Do not move anything before approval.**

## Step 7: Execute

On approval:

- **Moves:** `gh issue edit <n> --repo Alphyn44/dogear --milestone "<title>"`.
- **Deferrals:** `gh issue edit <n> --repo Alphyn44/dogear --remove-milestone`, plus a line in
  the brief's Later, maybe (or Still open) that names the issue.
- **Splits:** edit the brief first, then `/issue-create` the remainder into its destination,
  carrying the constraints already established so nothing is re-derived later. Edit the
  parent's body and title down to the surviving scope, and cross-link both ways.
- **Every move, deferral and split gets a comment saying why**, with the evidence. A move with
  no rationale gets re-litigated in three months by someone who reads only the title.
- Where Step 3 found a claim wrong, **correct the issue body**. A stale premise left in place
  will mislead whoever picks it up.
- Retitle when the scope no longer matches the title.

Then verify:

```bash
gh api repos/Alphyn44/dogear/milestones -X GET -f state=open --jq '.[] | "M\(.number) open=\(.open_issues) \(.title)"'
gh issue list --repo Alphyn44/dogear --milestone "<title>" --state open
```

Report the before and after counts and the remaining session estimate.

## Hard rules

- **Never close an issue.** Deferring is a milestone change; closing is a judgement that the
  work is not wanted, or `/ticket`'s landing step when it is done. This command only does the
  first.
- **Never rewrite the Decisions log.** A decision that was true when written stays as
  written, even when the ticket it produced moves. Note the move on the issue instead.
- **Never move an issue to make a milestone look achievable.** If the work genuinely
  belongs, the honest output is "this milestone is 12 sessions"; say that.
- **Do not commit.** Brief edits stay in the working tree for review.
