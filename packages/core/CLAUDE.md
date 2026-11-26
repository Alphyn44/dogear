# dogear-core: the overlay, its tests and the leak sentinel

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

**`hosts` is resolved here by `resolveHosts`, but the reasoning lives with the plugin.** See `packages/vite/CLAUDE.md` for why `ClientConfig.hosts` is omitted from the wire rather than defaulted onto it, and why the list is all-or-nothing.

**Three vitest environments, one config.** The DOM suites (`overlay`, `session`, `listeners`,
`teardown`, `describe`, `init.host-bail`, `badge`, `panel`, `controller`, `preference`,
`clipboard`) carry a `// @vitest-environment happy-dom` docblock; everything else stays `node`.
All geometry is pure functions tested in the node environment, because happy-dom has no layout engine and
`getBoundingClientRect` there returns zeros. B5's `submit` suite is `node` for the same reason
— it stubs `fetch` and touches no DOM, which is why the transport is a module of its own.

**Counting listeners in a test: spy on `window` and `document` themselves, never on
`EventTarget.prototype` alone.** happy-dom defines `addEventListener` as an own property on
both, and vitest installs its own `window.addEventListener` wrapper besides — so a prototype
spy records *none* of the window-level listeners, which is nearly all of them. It fails in the
worst way: the count reads zero both while running and after teardown, so every "the listeners
are gone" assertion passes without testing anything. `teardown.test.ts` and
`controller.test.ts` both spy per target for this reason, and both pair a
`> baseline` assertion with the `=== baseline` one so a vacuous pass cannot hide.

**The leak sentinel is internal to `dogear-core` on purpose.** `packages/core/src/sentinel.ts`
is not re-exported from `index.ts`, because `noop.ts` mirrors index's public surface and
the noop is exactly what production resolves to. Exporting it would push the sentinel into
every correct production build and make the leak check fire on a healthy repo.
