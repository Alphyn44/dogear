# @dogear/core

The overlay half of [dogear](https://github.com/Alphyn44/dogear) — click an element in
your running app, leave a comment on it, and have your coding agent receive that comment
already bound to the exact source file and line.

This package is the overlay itself: the hover outline, the comment box, the review panel,
source resolution, clipboard export, and the POST to a configurable endpoint. It is
framework-agnostic and knows nothing about Vite.

**You do not install this directly.** It arrives as a dependency of
[`@dogear/vite`](https://www.npmjs.com/package/@dogear/vite), which serves its dev bundle
to the browser. Install that instead:

```sh
npm i -D @dogear/vite
```

Its `exports` map sends both the `production` and the catch-all `default` condition to a
noop module, so any resolver whose conditions dogear does not recognise fails safe. That
is one of five layers keeping the overlay out of your production build — see
[the brief](https://github.com/Alphyn44/dogear/blob/main/dogear-brief.md#keeping-it-out-of-production).

## License

MIT — see [LICENSE](./LICENSE).
