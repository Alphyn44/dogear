# scripts: the leak gate

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

**The leak gate names each package rather than matching a prefix, and that is G5's one
real cost.** The `package-specifier` rule used to be the scope prefix `@dogear/`, which
covered a package added later for free. Unscoped, the equivalent prefix is `dogear-` — and
that string sits inside `data-dogear-src` and `data-dogear-component`, whose rules are in the
same table, so every stamped attribute would report two findings and the report would name
two rules for one bug. `PACKAGE_SPECIFIERS` in `scripts/check-leak.ts` is the explicit list
that replaced it; `check-leak.test.ts` asserts no needle is a substring of another, and
`scripts/packaging.test.ts` asserts every published name is in the list. An explicit list is
a list that can go stale, and those two are what stop it.
