# dogear-vite

The dev-only Vite plugin for [dogear](https://github.com/Alphyn44/dogear) — click an
element in your running app, leave a comment on it, and have your coding agent receive
that comment already bound to the exact source file and line.

The plugin does three things: it stamps a source attribute onto your JSX in dev, it
injects the overlay into the page, and it serves the endpoint the overlay posts to.

## Install

```sh
npm i -D dogear-vite
```

```js
import { dogear } from 'dogear-vite'

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
npm i -g dogear-cli    # `dogear` on your PATH
npm i -D dogear-cli    # so the committed MCP config resolves for everyone who clones
dogear init
```

## Options

Every option is optional, and the defaults are what most projects want.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | `false` injects nothing and serves no endpoint. Not a production-safety layer — `apply: 'serve'` is that |
| `endpoint` | `'/__dogear'` | Base path for dogear's HTTP routes. Must be a same-origin path below the site root: not `/` itself, no `//host`, no query, no fragment |
| `modifier` | `'alt'` | Which key arms the overlay. `'alt'`, `'ctrl'`, `'meta'` or `'shift'` |
| `transform` | `true` | Stamp `data-dogear-src` onto host JSX in dev. `false` keeps the whole overlay and falls back to the selector floor |
| `include` | `['**/*.jsx', '**/*.tsx']` | Which files the transform touches. Relative patterns resolve against the **git root**, not the Vite root |
| `exclude` | `['**/node_modules/**']` | Files the transform skips even when `include` matches. Setting this *replaces* the default, so keep the `node_modules` entry unless you mean to lose it |
| `app` | the `name` from the nearest `package.json` | What to record as the workspace package this server serves. It is what tells a monorepo's three dev servers' annotations apart |

A bad value passed here throws — it is your own code. The same bad value in
`config.json` is warned about and dropped, because that file is committed and one typo
should not break every clone's `npm run dev`.

## The config file

`.dogear/config.json` at your **git root** layers underneath the options above. A plugin
option always wins; an option you did not pass falls through to the file; a key the file
does not set falls through to the default. `dogear init` creates the file with
`{ "version": 1 }` and nothing else, so an untouched repository takes every default.

```json
{
  "version": 1,
  "modifier": "ctrl",
  "include": ["src/**/*.tsx"],
  "hosts": ["localhost", "*.localhost"]
}
```

| Key | Type | |
| --- | --- | --- |
| `version` | `1` | Schema tag. A value this dogear does not know is warned about, and the keys it *does* know are read anyway |
| `enabled` | boolean | As the option above |
| `modifier` | `"alt"` \| `"ctrl"` \| `"meta"` \| `"shift"` | As the option above |
| `endpoint` | string | As the option above, validated by the same rules |
| `transform` | boolean | As the option above |
| `include` | string or string[] | As the option above. A bare string is accepted and read as a one-element list |
| `exclude` | string or string[] | As the option above |
| `hosts` | string[] | The hostnames dogear will run on. No plugin option — see below |
| `agent` | `"claude"` \| `"cursor"` \| `"vscode"` \| `"none"` | Recognised so it is not warned about. Nothing reads it: `dogear init --agent` is where that choice lives |
| `app` | string | Recognised, and deliberately inert. This file is one per repository while `app` is one per Vite root, which is the ambiguity the option exists to remove — set it as a plugin option |

**Nothing in this file can break your dev server.** A key that is not in this table earns a
warning and is ignored; a key in it whose value is the wrong type earns a warning and falls
back to the default. That is the opposite of how the same value behaves as a plugin option,
and deliberately so: your `vite.config.ts` is your own code, while this file is committed
and read by everyone who clones the repository.

The file is read **once**, when the dev server starts. Editing it needs a restart, and the
`[dogear]` line that confirms which keys it set says so.

### `hosts`

The one key with no plugin option, because it is the only one that is a safety decision
rather than a preference — and safety configuration belongs in the repo-wide committed file
rather than in one developer's plugin call.

It is the list of hostnames the overlay will initialise on. The default:

```
localhost   *.localhost   127.0.0.0/8   ::1   *.local
10.0.0.0/8   172.16.0.0/12   192.168.0.0/16
```

Three pattern kinds: an exact hostname, a `*.suffix` wildcard, and an IPv4 CIDR range.
Suffix matching cannot reach `localhost.evil.com` — it matches the end of the name, not the
start.

Two things to know before you set it:

- **It replaces the default list; it does not extend it.** Narrowing to `["localhost"]`
  turns dogear off on your LAN address, which is usually what someone narrowing it means.
  Private ranges live *in* the list rather than beside it as an always-on rule, so there is
  exactly one answer to "what is allowed".
- **`[]` is honoured as "nowhere".** It is a legitimate thing to say, though
  `"enabled": false` says it more clearly.

This is the last of the five layers keeping dogear out of production, not the first — see
below. If you are reaching for it to make a production build safe, the plugin's
`apply: 'serve'` has already done that.

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
