---
description: Write a dogear issue that stays true. Verify the premise, write the brief story first when there is one, then file the what and why in story.md or bug.yml shape, never the how. Also rewrites an existing issue. Drafts for approval, never files without it.
argument-hint: "<what you want filed, a story ID like I1, or an existing issue number to rewrite>"
---

You are writing an issue for dogear (`Alphyn44/dogear`). An issue records **what is wrong or
missing and why it matters**. It does not record **how to fix it**: that is planned at pickup
time, against the code as it is then, by `/ticket`.

**The brief is the spec; the issue is the tracker** (CLAUDE.md). A story's design reasoning
lives in `dogear-brief.md`, and its acceptance criteria appear in both places word for word.
If the two would disagree, the brief changes first. Never let an issue become a second source
of truth.

**The test: would this sentence need editing if someone refactored without changing
behaviour?** If yes, it does not belong in the acceptance criteria, and it belongs in Notes
only as a risk to check (see Step 4). Renames, file splits and extracted helpers happen
constantly, and none of them change whether the problem is real.

**Name the behaviour in the product's vocabulary, not the code's.** "The prompt hook fails on
every prompt" survives every refactor. "`hook-config.ts` writes `CLI_ENTRY`" is wrong the
moment the constant moves.

## Why this command exists

Three things the brief already records, each a failure this command is shaped to prevent:

- **H5's original shape named its mechanism**: an input gating the publish *command*. #64
  then moved the release trigger and split the workflow, after which that mechanism was the
  wrong one: it would have left the publishing credential present in a run meant to publish
  nothing. What shipped gates on the *event*. An issue that carries its how goes stale when
  something next to it moves.
- **B7's second criterion could not be checked.** "It never appears in the user's own DOM
  queries or snapshot tests" was vacuous for component tests and unachievable for browser
  tests, and was amended during the ticket. A criterion nobody can evaluate is decoration.
- **E4's gate could go true with the work unfinished.** Its criteria covered only the
  `.gitignore` split, while four code comments assigned it the config reader too. The
  reader became E7. A gate that passes early teaches that the gate is decorative.

**`/ticket` Step 1 audits every claim the issue makes against the code**, so every
pre-computed fact you write down is not a shortcut; it is extra surface to be found wrong.
Write less, and make what you do write true.

## The request

`$ARGUMENTS` is what to file. Resolve in this order:

- **A number** (`47`, `#47`): **rewrite mode**. Read the existing issue and its comments; you
  are replacing a body, not filing a new one. See *Rewrite mode* below.
- **A story ID** (`I1`, `J3`): find the story in `dogear-brief.md` and check whether it is
  already tracked with `gh issue list --repo Alphyn44/dogear --state all --search "<ID> in:title"`.
  Tracked: stop and say so, or switch to rewrite mode if asked. Untracked: author mode, with
  the brief entry as the source.
- **Prose, a path, or pasted notes**: **author mode**.
- **Empty**: ask what to file before anything else.

## Step 1: Verify the premise (blocking)

Writing less does not mean checking less. The opposite: a short issue has nowhere to hide a
false claim. Before drafting, settle exactly these. This repo is indexed, so use
`codegraph_explore` first and `Read` when a verdict is close:

| Question | Why it decides whether to file at all |
|---|---|
| **Does the problem actually exist?** | The commonest outcome is "already built" or "already covered under another name" |
| **Is it the problem described, or a symptom?** | Filing the symptom produces a ticket that fixes nothing |
| **Is it already filed?** | `gh issue list --repo Alphyn44/dogear --state all --search "<words>"`. A duplicate splits the record |
| **Has the brief already ruled on it?** | Read the **Decisions log**, **Non-goals**, **Still open** and **Later, maybe**. An already-rejected approach is not a ticket, and an open question belongs in Still open |
| **Is the real deliverable a ruling?** | Then it is a decision issue and says so (Step 3). Do not file code work around an unsettled question |

For coverage claims specifically: **never audit by filename.** A behaviour is tested if a
suite exercises it, whatever that suite is called. Check the importers and what the parent
suites stub. The reverse also happens, and CLAUDE.md records the sharpest case: a listener
count taken by spying on `EventTarget.prototype` alone reads zero both while running and after
teardown, so a "the listeners are gone" assertion passes without testing anything. A suite
existing is not the behaviour being covered.

Report a verdict for each claim you will rely on, citing `file.ts:line`:

- `✅ Confirmed`: the code says what the claim says.
- `⚠️ Stale`: it was true once, or is partly true; say which part.
- `❌ Wrong`: the code says otherwise.
- `❓ Unverifiable`: the repo cannot answer it (third-party behaviour, a user's machine).

Report the verdicts before drafting. **If the premise does not hold, say so and do not
file.** "This is already covered by X" is a complete and successful outcome for this command.

## Step 2: Grill, briefly

Enough to write a true issue, not enough to plan one. Ask only what changes the body:

- **Scope.** Is this one issue or three? Different packages, or a decision plus work, means
  separate issues.
- **Why now.** Which milestone's question does it answer, and does anything genuinely block
  on it?
- **The done condition.** What observable state means this is finished? **Ask this even
  when it seems obvious.** It becomes the acceptance criteria, and an issue whose author
  cannot state them is not ready to file: the scope is still open, and that is what
  produces a ticket that gets worked repeatedly without ever being finishable.

If the answer is a genuine fork, `AskUserQuestion` with a recommendation first. Do not
interview about implementation; that is `/ticket`'s job, and writing it down here is the
failure this command exists to prevent.

## Step 3: Decide the kind

| Kind | Title | Shape | Brief |
|---|---|---|---|
| **Story**: a capability the brief should describe | `<ID> — <short title>`, the ID being the next free number in its epic | `story.md` | **Written first.** Draft the story entry: a bold `**<ID> — <title>**` line, the criteria as bullets, and a paragraph of reasoning only where the reasoning is not obvious. A new epic also needs its section and a Build order row, which is `/milestone-create`'s job |
| **Bug**: dogear behaves differently than its docs say | a plain sentence about the wrong behaviour | `bug.yml`, see below | None |
| **Decision**: the deliverable is a ruling (#64 is the model) | a plain sentence or question | `story.md` | Listed in **Still open** until settled; the settled answer goes in the Decisions log |
| **Other**: docs, chores, anything without a story | a plain sentence | `story.md` | None, unless it changes something the brief states |

The em-dash in `<ID> — <title>` is the separator every existing issue uses and the one
`/ticket` searches on. Keep it there. Prose you author uses none: colons, semicolons, commas,
parentheses or a new sentence instead.

**`bug.yml` is an issue form, so there is no body to copy.** Reproduce its labels as
headings, in order, and answer each one (CLAUDE.md): *What happens*, *Steps to reproduce*,
*What your dev server printed*, *Versions*, *Package manager*, *Browser*, *Operating system*,
*Before you file*. "Not a browser problem" and "n/a: this is `dogear init` output" are
answers. Then add `## Acceptance criteria`, because a bug with no gate is as unfinishable as
a story with none, and `## Notes` under Step 4's rules when something belongs there.

**Reproduce it before filing, when you can.** Output quoted from a real run beats a
paraphrase of what the code implies, and `--dry-run` makes most of `dogear init` safe to
run against a scratch repository.

## Step 4: Draft

For every kind except a bug, the body is `story.md`'s three sections:

```markdown
## Description

<What is true today, in product vocabulary, and why it matters: what breaks, who notices,
and what the failure looks like from outside. If it is silent or disguises itself as
something else, say so; that is usually the strongest argument in the issue. One to three
sentences is the template's target; a silent failure earns a paragraph.>

## Acceptance criteria

- [ ] <condition>
- [ ] <condition>

## Notes

<Only when something here applies. Delete the section otherwise.>
```

For a story, the criteria are **copied word for word from the brief entry**. The brief says
what the story is and why; the Description says what is true today and why that matters now.

### Acceptance criteria: the rules

This is the section that stops an issue being worked three times without anyone being able
to say it is finished. It is also where "how" sneaks back in wearing a costume, so:

- **Capability, not work.** "A batch submitted from a Next dev page lands in the git root's
  queue" is checkable in five years. "Add a route handler to `dogear-next`" is a plan with a
  checkbox next to it. **Name no file.**
- **Observable by someone who did not write the issue.** If checking it requires knowing
  what the author had in mind, it is not a condition. B7's first draft failed this.
- **It must be able to go false.** This repo's standing rule, from `check-leak.test.ts`,
  H8's classifier self-test and H3's `transform: false` leg: a guard that cannot fail has not
  passed, it has failed to run. The same holds for a criterion.
- **It must not be able to go true while the work is unfinished.** E4's gate did.
- **More than about 5 conditions is a scoping signal**, not a formatting problem. Two
  clusters of conditions is usually two issues. Raise it; do not truncate to fit.

For a decision, the condition is the ruling: *"It is decided whether init writes permission
rules for dogear's MCP tools, and the answer is recorded in the Decisions log."* Do not write
code conditions under a decision; they pin whichever answer the author assumed.

### Notes: what may go in, and what may not

Notes hold what someone picking the issue up would want to know first. They **may point**:
a file, a constant or a mechanism is allowed when it is **a risk worth checking**, verified
in Step 1 and cited. #35 is the model: the overlay mounts on `document.documentElement`, the
mount target is one named constant, and WebKit is where that choice is untested. That is a
pointer to a risk, not a plan.

Bold leads that recur:

- **Decide first.** A ruling that must be settled before code. A test or an implementation
  written before the ruling pins whichever answer the author assumed.
- **Constraints.** A Decisions-log entry or a Non-goal the work must respect. Cite it by its
  bold lead sentence; do not restate it.
- **Shape.** See the exception below.

Everything else here, cut on sight:

| Banned | Because |
|---|---|
| File paths, line numbers or test-file names **in the criteria** | The first rename invalidates them, and `/ticket` re-derives them anyway |
| Inventories: "N of M files covered", lists of what is or is not built | A snapshot presented as a fact; wrong the first time anything moves |
| Prescribed assertions, signatures or file layout | That is the plan, written against code that has since moved. H5's first shape |
| **Milestone names** | The milestone field already carries that relationship, and it moves when the relationship does. A name in the body is a second copy that cannot move, so it goes wrong silently |
| Design reasoning | It belongs in the brief story, where it is the spec. In the issue it is a second copy |
| Restating a Decisions-log entry | Cite its bold lead; two copies diverge |
| Tables of files | Always an inventory wearing a table |

### The exception: when the how *is* the decision

Carry mechanism only where choosing it is the deliverable, not an implementation detail:

- a new published package, which adds a name to the leak gate, the packaging test,
  `release.yml` and a manual first publish
- a new runtime dependency, which is Tyler's to install and review
- a change to a data contract in the brief: the Annotation, the queue file, the POST body,
  the MCP tools
- an algorithm chosen against real alternatives, where the rejected ones matter

Put it under **Shape.** and carry **the decision and its reason, not the artefact**. "Needs a
package of its own because core must stay framework-agnostic" is durable; export maps and
signatures are not.

### Length

There is no word cap. A wide decision space earns paragraphs, and #70's Notes are long for
good reason: two rollback shapes that fail differently. But length must come from
**irreducible facts and open decisions**, not inventory. "Long because three approaches are
live and the rejections matter" is correct. "Long because it lists twelve files" is not.

### Self-check before presenting

Walk your own draft and report the result. Do not skip this because the draft looks short:

1. **Rename test.** Would any criterion be wrong if a file were renamed or a helper
   extracted? Rewrite it. Would any Note? Then it must be a pointer to a risk, not a claim
   about structure.
2. **Re-derivation test.** Would `/ticket`'s audit produce this fact in under a minute? Then
   it is not yours to record.
3. **Truth test.** Is every surviving claim one you verified in Step 1 and can cite?
4. **Closing test.** Read only the criteria and ask: could someone who has never seen this
   issue decide, from the code, whether they are satisfied?
5. **Premature-close test.** Could every condition be true while the problem in the
   Description is still real? Then the gate is decorative and the issue will close early.
6. **Brief-match test** (stories only). Are the criteria word for word the brief entry's
   bullets?

## Step 5: Labels, milestone and edges

- **Labels.** A story or decision takes exactly one `epic:` label, for the epic it belongs to
  (`gh label list --repo Alphyn44/dogear`). A bug takes `bug`. **Every issue this command
  drafts also takes `ai-created`**, which is that label's definition.
- **Milestone.** Read the descriptions; each carries its own membership rule. Place against
  the rule, never against the title:

  ```bash
  gh api repos/Alphyn44/dogear/milestones -X GET -f state=open --jq '.[] | "\(.number)\t\(.title)\n\(.description)\n"'
  ```

  Keep the endpoint first: the hook allows `gh api` only in that shape (see
  `/milestone-create`). A milestone from before M8 is a one-line summary with no rule; its
  brief epic is the yardstick instead. Unsure between two: propose one, say why, and offer
  the other. **Deferred work takes no milestone**, and the brief's Later, maybe (or Still
  open, for a question) names it.
- **Edges.** Real GitHub dependencies, never prose: `--blocked-by` and `--blocking` at
  creation, `--add-blocked-by` and `--add-blocking` afterwards. **Only where the work
  genuinely cannot begin** (`story.md`): the milestone already carries build order, and a
  loose edge blocks closing an issue that is not really blocked.

## Step 6: Confirm, then write and file

Present, verbatim: the brief diff (for a story), the issue body, and the proposed title,
labels, milestone and edges. **Wait for approval.** One approval covers the brief edit and
the filing together.

On approval:

1. Edit `dogear-brief.md`. It stays in the working tree for Tyler to review and commit.
2. Write the body to a file in the scratchpad directory.
3. File it:

   ```bash
   gh issue create --repo Alphyn44/dogear --title "<title>" --body-file <path> \
     --label "<epic:x or bug>" --label ai-created --milestone "<title>" [--blocked-by <n>]
   ```

Report the URL. Where the brief names the story's issue elsewhere (Still open, a
cross-reference), patch the number in now.

## Rewrite mode (`/issue-create <n>`)

An issue that has collected correction comments is the signal this command was built for.

1. Read the body **and every comment**: `gh issue view <n> --repo Alphyn44/dogear --json
   title,body,labels,milestone,comments,blockedBy,blocking`. Later comments supersede earlier
   ones, and none outrank the code.
2. Re-verify against the code now. A comment from three weeks ago is a claim too.
3. **If the scope change touches a story, the brief moves first**: amend the story entry,
   then the issue's criteria to match it.
4. **Fold settled findings into the body.** A reader who opens the issue and stops before
   the comments must not be misled. Comments stay as history; the body becomes true.
5. **Split what the audits revealed to be separate.** A decision surfaced in a comment
   becomes its own decision issue, or a **Decide first.** Note, not a paragraph of a story.
6. **Give it acceptance criteria if it has none**, derived from what the audits settled.
7. Retitle when the scope no longer matches. Drop labels the rewrite invalidates.
8. `gh issue edit <n> --repo Alphyn44/dogear --body-file <path>`, then **comment saying what
   was corrected and why**. Rewriting a body silently destroys the record of what was
   believed and when.

Present the before and after and wait for approval, as in Step 6.

## Hard rules

- **Never file without approval.** An issue is linkable and quotable the moment it exists.
- **Never file without acceptance criteria.** An issue with no gate cannot be finished, only
  abandoned or worked repeatedly, and nobody can tell those apart from the outside. If the
  criteria cannot be stated, the scope is not settled: go back to Step 2.
- **Never file an unverified premise.** If Step 1 could not settle it, file a decision issue
  phrased as the open question, not a statement of fact.
- **Never close or reopen anything.** Closing is `/ticket`'s job, by hand, when the work
  lands on the milestone branch (CLAUDE.md).
- **Do not commit.** The brief edit stays in the working tree for review.
