# dogear-core

The overlay half of [dogear](https://github.com/Alphyn44/dogear) — click an element in
your running app, leave a comment on it, and have your coding agent receive that comment
already bound to the exact source file and line.

This package is the overlay itself: the hover outline, the comment box, the review panel,
source resolution, clipboard export, and the POST to a configurable endpoint. It is
framework-agnostic and knows nothing about Vite.

**You do not install this directly.** It arrives as a dependency of
[`dogear-vite`](https://www.npmjs.com/package/dogear-vite), which serves its dev bundle
to the browser. Install that instead:

```sh
npm i -D dogear-vite
```

Its `exports` map sends both the `production` and the catch-all `default` condition to a
noop module, so any resolver whose conditions dogear does not recognise fails safe. That
is one of five layers keeping the overlay out of your production build — see
[the brief](https://github.com/Alphyn44/dogear/blob/main/dogear-brief.md#keeping-it-out-of-production).

The last of those five lives here: `init()` refuses to run on a hostname outside its
allow-list, and does it silently, because a console warning would fire on exactly the
deployed page where dogear must be invisible. The list defaults to `localhost`,
`*.localhost`, `127.0.0.0/8`, `::1`, `*.local` and the private IPv4 ranges, and is
configured through `hosts` in `.dogear/config.json` — repo-wide, committed, and documented
on [`dogear-vite`](https://www.npmjs.com/package/dogear-vite)'s page. Setting it
*replaces* the defaults rather than extending them.

The overlay's own controls are in the [project
README](https://github.com/Alphyn44/dogear#the-loop): alt-click to annotate, `Ctrl+Alt+P`
to copy a batch, `Ctrl+Alt+D` to turn dogear off in the browser, and `__dogear.start()` to
turn it back on.

## License

MIT — see [LICENSE](./LICENSE).
