# dogear-host: what the Vite and Next hosts share

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

**Nothing here may import from `vite` or `next`, at runtime or for types.** This package is
inlined into both hosts, and a host-specific import would break the other one. J3 moved the
endpoint closure out of `dogear-vite` (`endpoint.ts`, `batch.ts`, `client.ts`, `client-route.ts`,
`config-file.ts`, `app-name.ts`), and the one Vite import it carried, `Connect` for the
middleware's type, became the local `EndpointHandler`. Connect accepts it structurally, so the
Vite call site did not change. `stamp.ts` still lives in `dogear-vite` until J2 moves it, and
`sentinel.ts` until J4: J1's rule is that the first story needing a module moves it.

**`EndpointOptions.forwarded` is the one thing only Next sets.** Behind Next's rewrite proxy,
`Host` names the loopback server (`changeOrigin: true` in Next 16's `proxy-request.js`), and the
page's host arrives in `x-forwarded-host`. With the flag set, `origin` comes from that header,
first entry only, and is left **absent** rather than falling back to `Host` when the header is
missing. Next sends no `x-forwarded-proto`, so `next dev --experimental-https` records `http`.
Vite never sets the flag, so a Vite server keeps ignoring a header any client could send.

**`resolveCoreDist` resolves from wherever it is inlined, not from here.** Its
`createRequire(import.meta.url)` runs inside the consuming package's `dist/index.js` after tsup
inlines it, so it finds `dogear-core` through *that* package's dependencies. `dogear-vite` declares
`dogear-core`; `dogear-next` does not yet, which is J4's job, and until then its client route
serves the missing-bundle stub.

The tests moved with the code. `client.test.ts` still imports core's source by relative path
(`../../core/src/…`), which works because this directory sits at the same depth `packages/vite/src`
did. `packages/vite/src/docs.test.ts` stayed behind, because what it pins is the Vite README.
