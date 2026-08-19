---
name: User story
about: A unit of work, usually a story from dogear-brief.md
title: "A0 — short imperative title"
labels: ''
assignees: ''
---

<!--
TITLE      "<story ID> — <short title>", e.g. "C1 — Attribute transform".
           The ID is the link back to the brief; nothing else needs to restate it.
           Work with no brief story just gets a plain title.

LABELS     One epic label: epic:pipe | epic:pointing | epic:localization |
           epic:delivery | epic:init | epic:safety | epic:release
MILESTONE  M0–M5.
DEPENDS    Real GitHub issue dependencies, not prose. Only where the work
           genuinely cannot begin — the milestone already carries build order,
           and a loose edge blocks closing an issue that isn't really blocked.

Set with --label / --milestone / --blocked-by / --blocking at creation, or
--add-blocked-by / --add-blocking afterwards. None of them is body text.

The brief is the spec, this issue is the tracker. If they disagree, change the
brief first. Never let an issue become a second source of truth.
-->

## Description

<!-- One to three sentences: what this is and why it matters. Write it as a user
     story ("As a developer, X so that Y") only where that genuinely reads
     better — most stories are clearer as a plain statement. -->

## Acceptance criteria

- [ ] Observable behavior, not implementation
- [ ] One box per independently verifiable thing

## Notes

<!-- Gotchas, decisions still open, things learned while scoping. Delete if empty. -->
