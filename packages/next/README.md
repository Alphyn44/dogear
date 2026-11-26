# dogear-next

The dev-only Next.js config wrapper for [dogear](https://github.com/Alphyn44/dogear). Click an
element in your running app, leave a comment on it, and have your coding agent receive that
comment already bound to the exact source file and line.

The wrapper does three things under `next dev`: it stamps a source attribute onto your JSX, it
adds the overlay to your root layout, and it serves the endpoint the overlay posts to. It works
under Turbopack and under webpack.

## Install

```sh
npm i dogear-next
```

A regular dependency, not a dev one. `next start` loads `next.config` in production too, so a
config that imports `dogear-next` has to be able to resolve it wherever your app runs. It does
nothing there: see [below](#it-is-not-in-your-production-build).

Wrap the export of your `next.config`:

```js
import { withDogear } from 'dogear-next'

export default withDogear(nextConfig)
```

That is the whole setup. Run `next dev`, alt-click an element, type a comment, `⏎` to queue
it, then open the badge in the corner to review the batch and submit. It lands in
`.dogear/queue.json` at your git root.

`withDogear` takes your config as an object or as a function of the phase, the two forms Next
accepts, and returns a function Next calls with the phase. Your app needs the **App Router**:
the overlay arrives as a tag written into the JSX `<html>` of your root layout, and a Pages
Router app renders none. The wrapper disables itself outside a git repository, since that is
where the queue resolves from.

Add `.dogear/queue.json` and `.dogear/*.tmp` to your `.gitignore`, or run `dogear init` below,
which does it for you. The queue is machine state and you almost certainly do not want it
committed.

To get those comments to an agent, install the CLI and run `dogear init` in the repository: it
registers dogear's MCP server with your agent and prints this same config change for you:

```sh
npm i -g dogear-cli    # `dogear` on your PATH
npm i -D dogear-cli    # so the committed MCP config resolves for everyone who clones
dogear init
```

## Options

The second argument, `withDogear(nextConfig, options)`. Every option is optional, and the
defaults are what most projects want.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | `false` adds nothing and serves no endpoint. Not a production-safety layer; the dev-phase check is that |
| `endpoint` | `'/__dogear'` | Base path for dogear's HTTP routes. Must be a same-origin path below the site root: not `/` itself, no `//host`, no query, no fragment. It ignores your `basePath` |
| `modifier` | `'alt'` | Which key arms the overlay. `'alt'`, `'ctrl'`, `'meta'` or `'shift'` |
| `transform` | `true` | Stamp `data-dogear-src` onto host JSX in dev. `false` keeps the whole overlay and falls back to locating the element by CSS selector and text snippet |
| `include` | `['**/*.jsx', '**/*.tsx']` | Which files the transform touches. Glob strings only, no `RegExp`, because Turbopack runs the loader in a worker and its options must be JSON. Relative patterns resolve against the **git root**, not your app's directory. Add `'**/*.js'` if your components are JSX in `.js` files |
| `exclude` | `['**/node_modules/**']` | Files the transform skips even when `include` matches. Setting this *replaces* the default; dependencies are skipped either way |
| `app` | the `name` from the nearest `package.json` above where `next dev` started | What to record as the workspace package this server serves. Set it if you run `next dev <dir>` from outside the app |

A bad value passed here throws when `next dev` starts, because it is your own code. The same bad
value in `config.json` is warned about and dropped, because that file is committed and one typo
should not break every clone's dev server.

## The config file

`.dogear/config.json` at your **git root** layers underneath the options above. An option you
pass always wins; an option you did not pass falls through to the file; a key the file does not
set falls through to the default. `dogear init` creates the file with `{ "version": 1 }` and
nothing else, so an untouched repository takes every default. The same file configures
`dogear-vite`, so a repository with both kinds of app has one place to set them.

```json
{
  "version": 1,
  "modifier": "ctrl",
  "include": ["app/**/*.tsx"],
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
| `hosts` | string[] | The hostnames dogear will run on. No option; see below |
| `agent` | `"claude"` \| `"cursor"` \| `"vscode"` \| `"none"` | Recognised so it is not warned about. Nothing reads it: `dogear init --agent` is where that choice lives |
| `app` | string | Recognised, and deliberately inert. This file is one per repository while `app` is one per app, which is the ambiguity the option exists to remove. Set it as an option |

**Nothing in this file can break your dev server.** A key that is not in this table earns a
warning and is ignored; a key in it whose value is the wrong type earns a warning and falls back
to the default. That is the opposite of how the same value behaves as an option, and
deliberately so: your `next.config` is your own code, while this file is committed and read by
everyone who clones the repository.

The file is read **once**, when `next dev` starts. Editing it needs a restart, and the
`[dogear]` line that confirms which keys it set says so.

### `hosts`

The one key with no option, because it is the only one that is a safety decision rather than a
preference, and safety configuration belongs in the repo-wide committed file rather than in one
developer's config.

It is the list of hostnames the overlay will initialise on. The default:

```
localhost   *.localhost   127.0.0.0/8   ::1   *.local
10.0.0.0/8   172.16.0.0/12   192.168.0.0/16
```

Three pattern kinds: an exact hostname, a `*.suffix` wildcard, and an IPv4 CIDR range. Suffix
matching cannot reach `localhost.evil.com`: it matches the end of the name, not the start.

Two things to know before you set it:

- **It replaces the default list; it does not extend it.** Narrowing to `["localhost"]` turns
  dogear off on your LAN address, which is usually what someone narrowing it means.
- **`[]` is honoured as "nowhere".** It is a legitimate thing to say, though `"enabled": false`
  says it more clearly.

This is the last of the layers keeping dogear out of production, not the first. See below.

## It is not in your production build

`withDogear` checks the phase Next passes it, and outside `next dev` it hands your config back
exactly as it received it. That one check covers the source stamps, the overlay's tag, the
endpoint server and its rewrite together, so `next build` and `next start` see your config and
nothing of dogear's. It is a check for the dev phase, never for "not building": `next start`
evaluates the config too, and it gets nothing either.

Further layers sit behind that one: export conditions that send every unrecognised resolver to a
noop module, a CI check that fails loudly if dogear's sentinel string reaches a production build
(Next's included), and a runtime hostname bail. See
[the brief](https://github.com/Alphyn44/dogear/blob/main/dogear-brief.md#keeping-it-out-of-production).

Nothing dogear does leaves localhost. No telemetry, no analytics, no version check.

Held the modifier and nothing happened? See
[Troubleshooting](https://github.com/Alphyn44/dogear#troubleshooting).

## Requirements

Node `^20.19.0 || >=22.12.0`, Next.js 16 with the App Router, under Turbopack or webpack.
Firefox, Chrome and Edge.

## License

MIT. See [LICENSE](./LICENSE).
