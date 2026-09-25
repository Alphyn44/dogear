---
description: Write a dogear milestone description that sorts. A question, a membership rule with an iff, a checkable exit test, and exclusions with destinations, plus its Build order row and epic label. Validates against real and drafted issues before creating. Also sharpens an existing milestone.
argument-hint: "<what the milestone is for, or an existing milestone number to sharpen>"
---

You are writing a milestone for dogear (`Alphyn44/dogear`). The deliverable is **the
description**, and a milestone description is a **sorting instrument, not a summary**. It
gets applied once per placement decision, usually months later, often by someone skimming.
So it must be holdable in your head, and it must **reject** things.

**A description that admits everything is not a test.** M0 to M7 were one-line summaries
("MCP server first, then clipboard. Resolve without hand-editing JSON."), and they worked,
because each milestone was exactly one brief epic of stories written in advance: the epic
did the sorting and the milestone just named it. They stop working the moment something
arrives that is not a story. M5 took three bugs (#47 to #49) by judgement, since its
description never said whether bugs found during a milestone belong to it; F4 (#34) sits with
no milestone at all, because Safety was cross-cutting. From M8 on, every description carries
the four parts below.

The nearest thing to a good description already here is M6's, and the reason is one
sentence: *"Nothing here is a suspected bug."* That is a named exclusion, and it is what lets
a reader reject a bug without asking anyone.

## The anatomy

```
<The question this milestone answers. One line.>

MEMBERSHIP RULE: an issue belongs here iff <condition>; everything else belongs in
<destination(s)>.

EXIT TEST: <n> conditions, all checkable. It cannot be claimed done while any is false:
1. <condition>. <BUILT | PARTIAL: which part | NOT BUILT>
2. ...

Out of scope: <thing> → <destination>.
```

The `→` is fine; em-dashes are not. The one em-dash allowed is in the title, `M<n> — Name`,
the separator every milestone uses.

## Hard caps

The caps here are absolute, unlike `/issue-create`'s guidance, because this text gets
*applied*, not read once, and a rule nobody can hold in their head silently stops being used:

| Part | Cap |
|---|---|
| The question | **One line.** If it needs two, the milestone asks two questions |
| Membership rule | **One sentence, 40 words or fewer.** Must say `iff`, and must name where the rest goes |
| Exit test | **10 conditions or fewer**, one line each |
| Out of scope | **3 or fewer**, each with a destination |

There is no total word cap: ten real conditions are long and that is fine.

**Blowing a cap is a scoping signal, not a formatting problem.** Fifteen exit conditions is
two milestones. A membership rule that needs three sentences has two rules hiding in it, and
issues will be placed against whichever half the reader remembers.

## Every milestone is an arc

A dogear milestone is titled `M<n> — Name`, where `n` is pick-up order, and it closes when its
exit test is satisfied. **There is no standing bucket, by decision.** Deferred work takes no
milestone, and the brief names it instead: **Later, maybe** for work that may never happen,
**Still open** for a question nobody has answered. So the destinations an out-of-scope line
may name are another milestone, or "Later, maybe" or "Still open" in the brief.

An arc with no exit test cannot be finished, only abandoned.

## Step 1: Read the neighbours (blocking)

`gh` has no milestone subcommand, and `gh api` is hook-blocked except for this repository's
milestones, **endpoint first**:

```bash
gh api repos/Alphyn44/dogear/milestones -X GET -f state=all --jq '.[] | "#\(.number)\t\(.state)\t\(.title)\topen=\(.open_issues)\n\(.description)\n"'
```

Put the endpoint anywhere but first and the hook blocks the call; so does a second `gh api`
in the same command, or a `-X` other than GET, POST or PATCH.

Then read the brief's **Build order** table and the epic sections of **Features and user
stories**. For a pre-M8 milestone they are the real description.

**Then the overlap check, which is the one people skip.** For every open milestone: is there
an issue, open or drafted, that **both** membership rules admit? If so, membership is
ambiguous and every future placement of that kind is a coin flip. Sharpen one rule or the
other before creating anything; you cannot fix this later without re-triaging both.

Watch for near-neighbours that mean different things. "Later, maybe" means *may never*; a
later milestone means *wanted, but not next*. A rule that does not distinguish them destroys
the distinction.

## Step 2: Draft the question and the rule

**The question is the milestone.** "Can a Next.js app get annotations bound to file and line,
in dev only?" does more sorting work than any list of areas, because an issue either moves
that answer or it does not.

Then the membership rule. It usually names the milestone's epic, then says what else is
admitted: bugs found while it is open, decisions it forces. Test the draft by trying to
**break** it:

- Name two issues it should admit and two it should reject. If you cannot state a rejection,
  the rule admits everything.
- Name the nearest thing that is *almost* in scope. It belongs in `Out of scope:` with a
  destination; that is the highest-value line in the description.
- Would a reader who has never seen the code apply it the same way you do?

## Step 3: Draft the exit test

Every condition must be checkable by someone who did not write it. Rules, each learned in
this repo:

- **A condition must be able to go false.** The standing rule from `check-leak.test.ts`, H8's
  classifier self-test and H3's `transform: false` leg: a guard that cannot fail has not
  passed, it has failed to run.
- **A condition must not be able to go true while the milestone's work is unfinished.** E4's
  criteria covered only the `.gitignore` split while four code comments assigned it the
  config reader, and the reader had to become E7.
- **Status is audited against the code, not against the issues.** Open issues are a claim
  about the code; the code is the code. Use `codegraph_explore`, and mark each `BUILT`,
  `PARTIAL` or `NOT BUILT`.
- **Write conditions as capability, not as work.** "A Next submit lands in the git root's
  queue" is checkable in five years. "Port the endpoint to a route handler" is not.
- **`PARTIAL` must say which part.** "PARTIAL: the CLI README names the files, not what
  triggers each" turns a vague status into a named gap.
- **A condition may depend on another milestone.** Say which, and order the milestones so the
  dependency is met first; that ordering is the Build order row's "Why here".

## Step 4: Dry-run against real issues (blocking)

A description that has never been applied is a hypothesis. Run it against every open issue
**and every issue being drafted in the same pass**:

```bash
gh issue list --repo Alphyn44/dogear --state open --limit 200 --json number,title,labels,milestone
```

Sort each one with the draft rule (admit, reject, or ambiguous) and report counts. Read the
ambiguous ones carefully; they are the rule's real output.

| Signal | Means |
|---|---|
| Admits **0** filed or drafted issues | Speculative. Do not create a milestone for work nobody has scoped |
| **Ambiguous more than about 3** | The rule is not a test yet. Sharpen and re-run before anything else |
| Admits an issue **another milestone also admits** | Step 1's overlap check failed. Fix the rule, not the issue |
| Admits far more than one arc can deliver | Say the session estimate plainly, then split. Do not shrink the description to make it look achievable |

Admitted issues that already have a milestone are **moves, and moves are Tyler's call**: list
each with its current milestone and what the new rule says, one line each.

## Step 5: Title, number, brief and label

The next number is the next free `M<n>` (Step 1's read shows them all). Numbers are pick-up
order, so inserting before an existing open milestone renumbers it: show the sequence and say
so.

**The brief moves first** (CLAUDE.md), in the same approval as the milestone:

- a row in the **Build order** table: milestone, the story range it contains, and why it sits
  where it does
- the epic's section under **Features and user stories**, with its one-line italic intro and
  its stories (each story is `/issue-create`'s to write in full)
- the epic count at the top of that section, if a new epic was added

And the label, since every milestone so far has one:

```bash
gh label create "epic:<name>" --repo Alphyn44/dogear --description "M<n> — <what it covers>" --color <hex>
```

**Issue bodies never name a milestone** (`/issue-create`); the field moves with the
relationship and a name in a body does not. **Descriptions may name other milestones**,
because a destination has to be nameable, but it does go stale. **Renaming or renumbering a
milestone means reading the other descriptions and the brief in the same pass.**

## Step 6: Present, then create

Show the description verbatim, the caps check (one line: which cap each part came in under),
the overlap verdict, the dry-run counts, the brief diff and the label. **Wait for approval.**

On approval: edit the brief, create the label, then write the description to a scratchpad
file and create the milestone. The endpoint comes first and the description comes from the
file, so no `$(...)` is needed:

```bash
gh api repos/Alphyn44/dogear/milestones -X POST -f title="M<n> — <Name>" -F description=@<path>
```

Then ask separately about the moves from Step 4, `AskUserQuestion` with a recommendation.
Only on approval:

```bash
gh issue edit <n> --repo Alphyn44/dogear --milestone "<title>"
```

Creating the milestone and populating it are two decisions. Do not fold them into one yes.

## Sharpen mode (`/milestone-create <n>`)

For a milestone whose description stopped sorting, or a pre-M8 one-liner that now has to
admit something that is not a story.

1. Read the description **and its members**, open and closed.
2. **The members are evidence of what the rule actually admits.** If what is in it does not
   match what the description says, one of the two is wrong; say which. A description
   rewritten to match a bloated membership just ratifies the bloat.
3. Derive the rule the members imply, then compare it to the stated one. The gap is usually
   a missing exclusion, not a missing condition.
4. Add the exit test if it has none, audited against the code.
5. Present, and on approval:
   `gh api repos/Alphyn44/dogear/milestones/<n> -X PATCH -F description=@<path>`
6. **Issues the sharpened rule now rejects do not move silently.** List them and hand them to
   `/milestone-triage`, which owns moves and the dependency check that goes with them.

## Hard rules

- **Never create or edit without approval.** A milestone description is a standing
  instruction to everyone who files afterwards.
- **Never move an issue without a separate approval.** Creating a container is not permission
  to fill it.
- **Never close, rename or delete a milestone as a side effect.** The hook refuses DELETE
  anyway; closing and renaming are Tyler's.
- **Never soften a description to make a milestone look achievable.** The honest output is
  "this is 12 sessions"; say that.
- **Do not commit.** The brief edit stays in the working tree for review.
