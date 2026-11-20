# dogear-host: what the Vite and Next hosts share

These notes load when Claude works with files under this directory. The repo-wide rules are in the root `CLAUDE.md`.

**Nothing here may import from `vite` or `next`, at runtime or for types.** This package is
inlined into both hosts, and a host-specific import would break the other one. J3 moved the
endpoint closure out of `dogear-vite` (`endpoint.ts`, `batch.ts`, `client.ts`, `client-route.ts`,
`config-file.ts`, `app-name.ts`), and the one Vite import it carried, `Connect` for the
middleware's type, became the local `EndpointHandler`. Connect accepts it structurally, so the
Vite call site did not change. J2 moved `stamp.ts` and its tests here; the default
`include`/`exclude` lists went to `patterns.ts`. `sentinel.ts` stays in `dogear-vite` until J4:
J1's rule is that the first story needing a module moves it.

**`stamp.ts` is the subpath `dogear-host/stamp`, never an index export.** esbuild keeps an
external import it cannot prove free of side effects, so a barrel re-export put
`import … from 'oxc-parser'` into `dogear-next`'s `dist/index.js` even though nothing there
calls the transform, and every `next.config` evaluation would have loaded the native binding.
`patterns.ts` exists so the config wrapper can read the defaults without reaching `stamp.ts`.
`packages/next/test-built/next-dev.test.ts` asserts the built `index.js` imports no parser.

**The transform's parser and map library stay external in both hosts.** `oxc-parser` and
`magic-string` are runtime `dependencies` of `dogear-vite` *and* `dogear-next`, which is what makes
tsup leave them as imports when it inlines this package (it externalises the building package's
own dependencies, whichever file imports them). `oxc-parser` ships a native binary per platform
and could not be inlined anyway. Its minor-locked range and "a day old" rule are in
`packages/vite/CLAUDE.md`, and both hosts must move together.

**`filter.ts` is a port of Vite's `createFilter`, exported only as `dogear-host/filter`.** Vite
inlines `@rollup/pluginutils`' function, built on `picomatch` with `dot: true`; `dogear-next`
cannot import Vite, so it uses this. `packages/vite/src/filter-parity.test.ts` runs one table
through both and requires identical answers, and it lives there because nothing in this package
may import `vite`, tests included. Strings only: a Turbopack loader's options must be JSON. It is a
subpath rather than an index export because `picomatch` is CommonJS, and esbuild keeps an unused
CommonJS import, so re-exporting it here would bundle `picomatch` into `dogear-vite`, which does not
depend on it. Unlike rollup's, it compiles each pattern once rather than per call.

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
