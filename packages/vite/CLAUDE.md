# dogear-vite: the plugin, its config file and the stamp transform

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

**Since J3 the endpoint, the config-file reader, the app name and the client-tag helpers live in
`packages/host/src/`** (`dogear-host`, inlined here by tsup), and since J2 so does the stamp
transform, and since J4 the sentinel and `validateModifier`. The notes below still describe
them. What stays here is the plugin itself. The plugin still filters with **Vite's own**
`createFilter`; `filter-parity.test.ts` here holds `dogear-host/filter`, Next's port, to it.

**J4 made the shared transform parse `.js` as JSX.** That reaches this plugin only if someone adds
`.js` to `include`; the default names `.jsx` and `.tsx`, so nothing changed for anyone who had not.

**E7 gave `.dogear/config.json` its reader, and the layering is three lines of `??` guarding
one rule.** `packages/host/src/config-file.ts` returns *only the keys that survived
validation*, and `configureServer` layers them as `option ?? file ?? default`. `??` rather
than `||` is load-bearing — it falls through on `undefined` alone, so a literal `enabled:
false` or `transform: false` option still beats the file, and a key the file omits reaches the
**default** instead of a value the layering invented. `Object.keys()` on the result is also
the confirmation line's content, which is why a rejected key is *dropped* rather than
repaired: absent is a state the whole chain already handles. Four ordering facts matter.
`findGitRoot` moved **above** the option resolution, because the file is found from the git
root; the `options.enabled === false` check stayed **above that**, because a plugin option is
dispositive by precedence and a disabled project must not be stoppable by a config it will
never read; the file is read **once**, like `gitRoot` and `app`, so editing it needs a dev
server restart that the confirmation line says out loud; and `app` is **not** layered — it is
per Vite root while this file is per repo, which is the ambiguity C4 added the field to remove.

**Reads may tolerate, writes must refuse — and this file is a read, so nothing in it throws.**
A bad `dogear({ modifier: 'banana' })` still throws in `validateModifier`; the same value in
`config.json` earns a warning and is dropped. The audiences differ: a `vite.config.ts` is the
author's own code, while `config.json` is *committed*, so one person's typo would otherwise
break every clone's `npm run dev`. The endpoint is validated by **calling `normaliseEndpoint`
inside a `try`** rather than by restating its rules — an earlier draft accepted any non-empty
string and let `"endpoint": "/"` throw out of the plugin a few lines later, which
`index.test.ts` caught. That same function now also rejects a protocol-relative `//host` and
anything carrying `?` or `#`: since F4 the endpoint becomes the injected `<script>`'s `src`,
so `//evil.com` would have fetched core from a third-party host.

**`hosts` is the one key with no plugin option, and it is omitted from the wire rather than
defaulted onto it.** It is F3's allow-list — repo-wide safety configuration, so the repo-wide
committed file is where it belongs. `ClientConfig.hosts` is absent unless the file set one,
because serialising `dogear-vite`'s copy of `DEFAULT_HOSTS` would *pin* it: a plugin a
version behind `dogear-core` would keep overriding core's list on behalf of a project that
never chose one. In core it is resolved by **`resolveHosts`, deliberately not by
`resolveOptions`** — `ResolvedOptions` is `createSession`'s parameter and every field on it is
one the session reads, while the list is consumed once by the guard before a session exists.
That split is also what let `init()`'s host check stay literally its first line. `resolveHosts`
is **all-or-nothing** where every other resolution is per-field: a malformed array falls back
to the defaults, because filtering would silently re-widen a list its author was narrowing.
`[]` is well-formed and honoured as "nowhere". `noop.ts` mirrors the new
`isCurrentHostAllowed(hosts?)` arity for the reason its own comment gives.

`dogear-vite` depends on `dogear-core` to find that bundle, and resolves
`dogear-core/package.json` rather than the package name — resolving the name from Node names
no `development` condition, so it lands on `dist/noop.js`. A `./dev` subpath would read better
and was rejected: it would be a second live entry point a bundler could follow into
production, which is the hole F1 layer 3 exists to close.

`packages/vite/src/index.test.ts` shares **one** temp git root across the whole file, created
in `beforeAll` — so a test needing a `.dogear/config.json` writes it through the `withConfig`
scope, never a bare `writeFileSync`. A leaked config would be read by every test after it and
they would keep passing, silently running against a configuration they never asked for.

**`packages/host/src/stamp.ts` imports nothing from `vite` or `next`.** Its parser is
`oxc-parser`, a dependency, because Vite 7 has none to re-export, and its path separator fix is a
local replace. A value import from `vite` there would pass every workspace suite, which has Vite 8
installed, and break only in a Vite 7 project or under Next. `stamp.test.ts` holds it as a source
rule. `oxc-parser` is a dependency of `dogear-next` too since J2, so **bump both manifests
together**. It sits at a minor-locked `^0.152.0` because Oxc changes
AST details between 0.x minors; see the brief's Decisions log. **Bump it only to a minor at
least a day old**: Yarn 4 quarantines younger versions by default, the range has nothing
older to fall back on, and `test:managers` fails its Yarn legs with `YN0016` until the gate
passes. That failure is the guard, so do not loosen the gate in the fixture.
