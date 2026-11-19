# test-browser: the round trip in a real browser

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

**H3's browser suite could not use `examples/react-app`, and the reason generalises.** The
endpoint writes to `queuePathFor(findGitRoot(server.config.root))`, the example's git root is
*this repository*, and there is no override — so every run would append test annotations to the
developer's own `.dogear/queue.json` and stamp paths naming this repo's real source. So
`test-browser/` copies a committed fixture app into a `mkdtemp` directory with a bare `.git` of
its own, the same conclusion `createScratchProject` reached for H1. It **installs nothing**:
`react`, `@vitejs/plugin-react` and `vite` are hoisted to the workspace root, so one
**junction** at `<scratch>/node_modules` reaches them along with the workspace symlinks for
`dogear-vite` and `dogear-core` — which means the fixture consumes the *built* plugin through
its exports map, exactly as the example app does and for the same F1-layer-3 reason. Two lines
in the generated `vite.config.js` exist only because of that junction: `server.fs.allow` must
name both roots, since Vite realpaths `react` and `dogear-vite` back into this repository and
would otherwise 403 them; and `cacheDir` must be moved off its default of
`<root>/node_modules/.vite`, which *is* this repository's `node_modules` through the link.
`discardFixture` unlinks before it deletes — Node is documented not to follow links when
removing, but that is not a basis for pointing `rmSync(recursive)` at a live handle on the
developer's own tree.

**Nothing in that suite queries dogear's DOM, because nothing can — and the constraint improved
it.** The shadow root is `closed`, `window.__dogear` carries only `sentinel`/`stop`/`start`/
`running`, and no test-only handle was added: B7's guarantee is a feature. So every step is
real input — a keyboard-modified pointer event, `Enter`, a click on the badge, `Ctrl+Enter` —
which is what the story asked for anyway. The badge is the panel's **only** handle
(`registry.on(badge.element, 'click', togglePanel)`; there is no chord), so `badgePoint()` is
derived from `.badge`'s two inset constants in `styles.ts` and **checked with a hit test before
it is used** — a restyle then fails naming that function, instead of surfacing three steps
later as a submit that silently wrote nothing. The one thing a closed root does leave visible
is that hit test: a hit inside retargets to the host, so `elementFromPoint` naming
`dogear-overlay` is how the suite knows anything at all.

**The `transform: false` leg is the story, not a bonus case.** A test asserting only that *an
annotation arrived* passes on a build where the attribute transform stopped running entirely,
because C3's selector-and-text floor still produces an item. So the identical gesture runs
against a second server configured `transform: false` and must produce an annotation with **no**
`via: 'attribute'` site while still carrying a resolved selector — the overlay demonstrably
working, only the resolution absent. Same standing rule as `check-leak.test.ts`, H8's
classifier self-test and H7's `dependencies.total > 0`: a guard that would go green forever has
not passed, it has failed to run.
