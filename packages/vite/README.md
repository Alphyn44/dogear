# @dogear/vite

The dev-only Vite plugin for [dogear](https://github.com/Alphyn44/dogear) — click an
element in your running app, leave a comment on it, and have your coding agent receive
that comment already bound to the exact source file and line.

The plugin does three things: it stamps a source attribute onto your JSX in dev, it
injects the overlay into the page, and it serves the endpoint the overlay posts to.

## Install

```sh
npm i -D @dogear/vite
```

```js
import { dogear } from '@dogear/vite'

export default defineConfig({
  plugins: [dogear()],
})
```

That is the whole setup. Alt-click an element, type a comment, `⏎` to queue it, then open
the badge in the corner to review the batch and submit — and it lands in
`.dogear/queue.json` at your git root.

To get those comments to an agent, install the CLI and run `dogear init` in the
repository — it registers dogear's MCP server with your agent and writes this same config
change for you:

```sh
npm i -g @dogear/cli
dogear init
```

## Options

Every option is optional, and the defaults are what most projects want.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | `false` injects nothing and serves no endpoint. Not a production-safety layer — `apply: 'serve'` is that |
| `endpoint` | `'/__dogear'` | Base path for dogear's HTTP routes. Must be a same-origin path: no `//host`, no query, no fragment |
| `modifier` | `'alt'` | Which key arms the overlay. `'alt'`, `'ctrl'`, `'meta'` or `'shift'` |
| `transform` | `true` | Stamp `data-dogear-src` onto host JSX in dev. `false` keeps the whole overlay and falls back to the selector floor |
| `include` | `['**/*.jsx', '**/*.tsx']` | Which files the transform touches. Relative patterns resolve against the **git root**, not the Vite root |
| `exclude` | `['**/node_modules/**']` | Files the transform skips even when `include` matches. Setting this *replaces* the default, so keep the `node_modules` entry unless you mean to lose it |
| `app` | the `name` from the nearest `package.json` | What to record as the workspace package this server serves. It is what tells a monorepo's three dev servers' annotations apart |

`.dogear/config.json` at the git root layers underneath these — a plugin option always
wins, an absent option falls through to the file, and an absent key falls through to the
default above. `app` is the one exception and takes no file value: that file is one per
repository while `app` is one per Vite root, which is the ambiguity the field exists to
remove. See [the brief's Config
section](https://github.com/Alphyn44/dogear/blob/main/dogear-brief.md#config) for the full
key list.

A bad value passed here throws — it is your own code. The same bad value in
`config.json` is warned about and dropped, because that file is committed and one typo
should not break every clone's `npm run dev`.

## It is not in your production build

The plugin declares `apply: 'serve'`, so it does not exist during a build. That covers
both the injected script and the attribute transform, so your production DOM is untouched
and your bundle contains nothing of dogear's.

Four further layers sit behind that one: a gated dynamic import for non-Vite consumers,
export conditions that send every unrecognised resolver to a noop module, a CI check that
fails loudly on a leaked sentinel string, and a runtime hostname bail. See
[the brief](https://github.com/Alphyn44/dogear/blob/main/dogear-brief.md#keeping-it-out-of-production).

Nothing dogear does leaves localhost. No telemetry, no analytics, no version check.

## Requirements

Node `^20.19.0 || >=22.12.0`, Vite 8. Firefox, Chrome and Edge.

## License

MIT — see [LICENSE](./LICENSE).
