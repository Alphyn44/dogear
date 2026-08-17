import { CONFIG_FILE, findGitRoot, QUEUE_DIR } from '@dogear/queue'
import type { FilterPattern, Plugin } from 'vite'
import { createFilter } from 'vite'

import { findAppName } from './app-name.js'
import type { ClientConfig, Modifier } from './client.js'
import {
  buildClientConfig,
  clientScriptSrc,
  MODIFIERS,
  resolveCoreDist,
} from './client.js'
import { readConfigFile } from './config-file.js'
import { createEndpoint, DEFAULT_ENDPOINT, normaliseEndpoint } from './endpoint.js'
import { SENTINEL } from './sentinel.js'
import { stampSource } from './stamp.js'

/**
 * Which files the JSX transform touches by default — C1 (#15), and the same pair the
 * brief's `.dogear/config.json` names.
 *
 * JSX-only by design. A `.js` holding JSX is not parsed as JSX by Oxc, and forcing it would
 * mean dogear deciding a file's language against the project's own toolchain. The brief
 * lists `.js` files among the places the attribute legitimately does not reach; they get
 * the selector floor (C3) instead.
 */
const DEFAULT_INCLUDE = ['**/*.jsx', '**/*.tsx']

/**
 * Never transform dependencies. Stamping them would point the agent at code inside
 * `node_modules` that it has no business editing, and a linked workspace dependency is
 * already covered by its own dev server.
 */
const DEFAULT_EXCLUDE = ['**/node_modules/**']

export interface DogearOptions {
  /**
   * Turn dogear off for this project entirely. Default `true` — B6 (#13).
   *
   * `false` means **nothing is injected and no endpoint is served**: not an inert overlay, no
   * script tag, no bundle sent to a page that asked for none. The same call the missing-git-
   * root branch below already makes.
   *
   * It also settles precedence without any code: B6's in-browser toggle lives in
   * `localStorage` and is per-origin, and it cannot contradict this, because a disabled plugin
   * never puts dogear in the browser to be toggled. A committed `enabled: false` is off for
   * everyone who clones the repo.
   *
   * `.dogear/config.json` layers underneath — E7 (#40) — but this option is checked *first*
   * and on its own: an explicit `false` here is dispositive by precedence, so no file read
   * can change the answer, and a disabled project must not be stoppable by a dogear
   * misconfiguration it will never use.
   *
   * Not a production-safety layer. `apply: 'serve'` is that, and this changes nothing about
   * what a build contains — see the brief.
   */
  readonly enabled?: boolean
  /**
   * Base path for dogear's HTTP endpoints. Default `/__dogear`, matching Vite's own
   * `/__vite_ping` convention.
   *
   * `.dogear/config.json` layers underneath this — E7 (#40). Plugin options override the
   * file, so this is the layer that wins when both are set.
   *
   * Must be a same-origin path: no protocol-relative `//host`, no query, no fragment. It
   * becomes the `src` of the injected `<script>` as well as the middleware's mount point —
   * see `normaliseEndpoint`, which rejects the rest.
   */
  readonly endpoint?: string
  /**
   * Which key arms the overlay. Default `'alt'`.
   *
   * Same precedence as {@link DogearOptions.endpoint}: E7 (#40) layers `.dogear/config.json`
   * underneath this, and neither reaches past it. A bad value **here** throws, while a bad
   * value in the file is warned about and dropped — see `validateModifier`.
   *
   * `'meta'` is the Windows key on Windows, where the OS claims it on keyup — it works, but
   * it is a poor choice there.
   */
  readonly modifier?: Modifier
  /**
   * Stamp `data-dogear-src` onto host JSX elements in dev. Default `true` — C1 (#15).
   *
   * `false` keeps the whole overlay: you still point, comment and submit, but annotations
   * carry no exact source location and fall back to the selector floor (C3), exactly as they
   * do in a Vue or Svelte app. That is the axis this option exists on — it is about source
   * *resolution*, not about whether dogear runs. {@link DogearOptions.enabled} is the latter.
   *
   * Same precedence as the options above: E7 (#40) layers `.dogear/config.json` underneath,
   * where the brief already names this field.
   */
  readonly transform?: boolean
  /**
   * Which files the transform touches. Default `['**\/*.jsx', '**\/*.tsx']`.
   *
   * **Relative patterns resolve against the git root**, not the Vite root and not `cwd` —
   * the same root the stamped paths themselves are relative to. In a monorepo that is what
   * lets one dev server stamp a shared `packages/ui` component it imports from outside its
   * own Vite root, which anchoring to the Vite root would silently skip.
   *
   * E7 (#40) layers `.dogear/config.json` underneath. The file can only express a string or
   * an array of them — JSON has no `RegExp` — and it sits at the git root, so a relative glob
   * written there already anchors where its author would expect.
   */
  readonly include?: FilterPattern
  /**
   * Files the transform skips even when {@link DogearOptions.include} matches. Default
   * `['**\/node_modules/**']`; setting this replaces that rather than extending it, so
   * keep the `node_modules` entry unless you mean to lose it.
   *
   * Layered from `.dogear/config.json` alongside {@link DogearOptions.include} — E7 (#40)
   * added it to the recognised set, since a file that can widen `include` without adjusting
   * the skip list is a half-configurable filter.
   */
  readonly exclude?: FilterPattern
  /**
   * What to record as the workspace package this server serves — C4 (#18). Defaults to the
   * `name` from the nearest `package.json` above the Vite root.
   *
   * The queue resolves from the git root, so a monorepo's three dev servers all append to
   * one file; this is the field that tells their annotations apart when two apps both have a
   * `Button`. Derived rather than configured in the ordinary case — set it when the package
   * has no name, or when its published name is not what you would call the app.
   *
   * **Unlike the options above, E7 (#40) does not layer `.dogear/config.json` under this
   * one.** That file lives at the git root, one per repo, and this value is per Vite root —
   * a monorepo's three servers would all read the same key and tag their annotations
   * identically, which is the exact ambiguity the field exists to remove. The nearest
   * `package.json` is already the per-package layer, so the fallback that would matter is
   * the one that is here.
   */
  readonly app?: string
}

/** What `configureServer` learned, and `transformIndexHtml` needs. */
interface Injection {
  readonly endpoint: string
  readonly config: ClientConfig
}

/** What `configureServer` learned, and the `transform` hook needs — C1 (#15). */
interface Stamping {
  readonly gitRoot: string
  readonly matches: (id: string) => boolean
}

/**
 * dogear's Vite plugin.
 *
 * It injects the dev script (A1), serves the annotations endpoint (A2), and stamps
 * `data-dogear-src` onto host JSX elements (C1).
 *
 * **`apply: 'serve'`** is the primary production defense, not a convenience. The plugin
 * does not exist during `vite build` at all, which covers the script injection and the
 * attribute transform with one line. Every other layer in the brief's "Keeping it out of
 * production" is a backstop behind this one — including the sentinel below, which exists
 * so that `npm run check:leak` has something to catch if this line is ever wrong.
 *
 * **`enforce: 'pre'`** is load-bearing for the C1 transform below. Vite runs `pre` plugins
 * before the React plugin compiles JSX, so `stampSource` sees real JSX syntax rather than
 * already-compiled `jsx()` calls. `stamp.integration.test.ts` is what holds that ordering
 * in place — it asserts the attribute survives into the compiled output.
 *
 * Note there is no production/noop `exports` split here, unlike @dogear/core. This
 * package is a devDependency that is only ever imported by a Vite config, so it has
 * no path into an application bundle to defend.
 */
export function dogear(options: DogearOptions = {}): Plugin {
  /**
   * Set by `configureServer`, read by `transformIndexHtml`. `undefined` means "do not
   * inject" — either the hooks have not run, or dogear disabled itself.
   *
   * Safe as closure state on two counts. Vite awaits every `configureServer` hook before it
   * installs the middlewares that serve HTML, so there is no ordering in which
   * `transformIndexHtml` runs first. And `dogear()` returns a fresh object per call (pinned
   * by a test in ./index.test.ts), so two Vite roots in one process get two closures.
   */
  let injection: Injection | undefined

  /**
   * Set by `configureServer`, read by `transform`. `undefined` means "do not stamp".
   *
   * Separate from `injection` because the two answer different questions — `transform:
   * false` disables stamping while leaving the overlay fully injected — but assigned under
   * the same preconditions, and that part is not optional. No git root means no endpoint
   * and no tag; it must also mean no stamp, because an attribute naming a path relative to
   * a repository dogear could not find is worse than no attribute at all.
   *
   * Safe as closure state for the same two reasons `injection` is: Vite awaits every
   * `configureServer` hook before it serves anything, and `dogear()` returns a fresh object
   * per call.
   */
  let stamping: Stamping | undefined

  return {
    name: 'dogear',
    apply: 'serve',
    enforce: 'pre',

    /**
     * The browser→disk half of the pipe (A2).
     *
     * Registered in the hook body rather than from a returned function, and that is the
     * load-bearing detail. Vite installs its own middlewares after `configureServer` runs,
     * so a middleware added here sees requests first; one added from the returned function
     * runs after them, by which point the SPA fallback has already answered
     * `/__dogear/annotations` with `index.html` and a 200.
     *
     * The endpoint is validated here rather than in the factory above so that a bad
     * `endpoint` option cannot throw during `vite build`. The plugin is excluded from
     * builds by `apply: 'serve'`, and a dev-tool misconfiguration taking down a production
     * build would invert the entire point of that line.
     */
    configureServer(server) {
      // B6 (#13). Before `normaliseEndpoint`, so a project that has turned dogear off cannot
      // be stopped by a dogear misconfiguration — `enabled: false` and a bad `endpoint` in
      // the same config should start the dev server, not throw at it.
      //
      // `injection` is left undefined, so `transformIndexHtml` emits nothing. Coupling the
      // two is the same rule the git-root branch below states: no endpoint means no tag,
      // because a tag whose import 404s is a worse failure than absence.
      if (options.enabled === false) {
        server.config.logger.info(
          '[dogear] disabled by config (`enabled: false`). No script is injected and no ' +
            'endpoint is served.',
        )
        return
      }

      // Resolved once: the repository root cannot move while this process lives. The
      // brief's "never cache" rule is about queue *contents*, which are re-read on every
      // single write — see queue.ts. Conflating the two would mean walking the filesystem
      // on every request to learn something that cannot have changed.
      //
      // **Ahead of the option resolution below since E7 (#40)**, because `.dogear/config.json`
      // is found from here and it is one of the three layers those options come from. The
      // `enabled: false` check above deliberately stays in front of both: a plugin option
      // beats the file by definition, so no file read can change that answer, and a project
      // that has turned dogear off should not be able to have its dev server taken down by a
      // dogear misconfiguration of any kind.
      const gitRoot = findGitRoot(server.config.root)

      if (gitRoot === undefined) {
        // Warn and stay inert rather than throw. The queue location is undefined outside a
        // repository, but taking down someone's dev server over a dev tool is the wrong
        // trade — they came here to work on their app.
        //
        // `injection` is left undefined, so nothing is injected either. Coupling the two is
        // deliberate: an overlay that can point at elements but can never submit them is
        // half a tool, and the failure would surface as a MIME error from a client.js that
        // Vite's SPA fallback answered with index.html — which reads like a dogear bug
        // rather than "you are not in a git repository".
        server.config.logger.warn(
          `[dogear] no .git found above ${server.config.root}. dogear is disabled: the ` +
            'queue resolves from the git root, and there is no repository to resolve it ' +
            'from.',
        )
        return
      }

      // E7 (#40). The middle layer: plugin option, then this file, then the default. Every
      // `??` below leans on that order, and `??` rather than `||` is load-bearing — it falls
      // through only on `undefined`, so a literal `enabled: false` or `transform: false`
      // option still beats the file, and a key the file does not set falls to the *default*
      // rather than being overwritten with one.
      //
      // Read once, like the git root above. Vite restarts on a `vite.config` change and knows
      // nothing about this file, so editing it needs a dev server restart — which the
      // confirmation line below says out loud rather than leaving to be discovered.
      const file = readConfigFile(gitRoot, (message) => {
        server.config.logger.warn(message)
      })
      const supplied = Object.keys(file)

      if ((options.enabled ?? file.enabled) === false) {
        // Separate from the option branch at the top of this hook, because the two name
        // different places to go and undo it. Same consequence: no middleware, no tag.
        server.config.logger.info(
          `[dogear] disabled by ${QUEUE_DIR}/${CONFIG_FILE} (\`enabled: false\`). No script ` +
            'is injected and no endpoint is served.',
        )
        return
      }

      const endpoint = normaliseEndpoint(
        options.endpoint ?? file.endpoint ?? DEFAULT_ENDPOINT,
      )
      // The *normalised* endpoint, not the configured one — core POSTs to
      // `<endpoint>/annotations`, and it has to be the path the middleware below is
      // actually mounted at. B5 (#12).
      //
      // `hosts` has no plugin option above it: it is F3's allow-list, repo-wide safety
      // configuration that belongs in the repo-wide committed file. Passed through as
      // `file.hosts`, so an unset key leaves it off the wire entirely and core keeps its own
      // defaults — see `ClientConfig`.
      const config = buildClientConfig({
        modifier: validateModifier(options.modifier) ?? file.modifier,
        endpoint,
        hosts: file.hosts,
      })

      const clientDist = resolveCoreDist()
      if (clientDist === undefined) {
        // Not fatal — the route answers with a stub module that says the same thing in the
        // browser console. Said here too, because the terminal is where someone who just
        // cloned the repo is actually looking.
        server.config.logger.warn(
          '[dogear] @dogear/core has not been built, so the overlay will not load. Run ' +
            '`npm run build -w @dogear/core`.',
        )
      }

      // C4 (#18). Resolved once, for the same reason the git root above is: the Vite root
      // cannot move while this process lives, and neither can the name of the package
      // containing it. The brief's "never cache" rule is about queue *contents*.
      //
      // An explicitly configured empty string reads as "not set" rather than stamping `""` —
      // one representation of absence, matching how the note is handled at the endpoint.
      const app = options.app?.trim() || findAppName(server.config.root, gitRoot)

      server.middlewares.use(createEndpoint({ gitRoot, endpoint, clientDist, app }))

      // One line, once, naming both bindings — B6's (#13) other discovery vector.
      //
      // The panel's hint line only reaches someone who already has annotations queued, and
      // the developer most likely to want the kill switch is the one who has never
      // deliberately opened dogear at all. The terminal is where they are looking.
      server.config.logger.info(
        `[dogear] ready — ${config.modifier}-click an element to annotate, ` +
          'Ctrl+Alt+D to turn dogear off.',
      )

      // E7 (#40). Only when the file actually contributed something, which is why it is
      // `supplied.length` and not "does the file exist". `dogear init` writes `{"version": 1}`
      // and stops, so an init'd repo that has never been edited supplies nothing and stays as
      // quiet as it was before this ticket — the commonest case by far, and the one a line
      // here would turn into noise on every dev server start.
      //
      // It is the only confirmation this file will ever get: nothing else reads it, so
      // "did my config apply?" is otherwise answerable only by observing dogear's behaviour.
      if (supplied.length > 0) {
        server.config.logger.info(
          `[dogear] ${QUEUE_DIR}/${CONFIG_FILE} set ${supplied.join(', ')}. ` +
            'Restart the dev server to pick up changes to it.',
        )
      }

      // C1 (#15). Resolved here rather than per-request because neither the git root nor
      // the option patterns can change while this process lives, and `createFilter`
      // compiles its globs once.
      //
      // `resolve: gitRoot` is the load-bearing argument. Left to itself `createFilter`
      // resolves relative patterns against `process.cwd()`, which is wherever npm happened
      // to start the dev server — in a workspace that is the package directory, not the
      // repo. Anchoring to the git root instead makes one root govern the whole feature:
      // the globs a user writes and the paths the attribute carries mean the same thing.
      //
      // The file layers under all three since E7 (#40), and `resolve: gitRoot` needs no
      // adjusting for it: `.dogear/config.json` sits at that same root, so a relative glob
      // written in the file already means what its author would expect.
      if ((options.transform ?? file.transform) !== false) {
        stamping = {
          gitRoot,
          matches: createFilter(
            options.include ?? file.include ?? DEFAULT_INCLUDE,
            options.exclude ?? file.exclude ?? DEFAULT_EXCLUDE,
            { resolve: gitRoot },
          ),
        }
      }

      // Assigned last, after the endpoint that may throw and after the middleware is
      // registered — so there is no window in which the tag is injected but the route that
      // serves its import is not.
      injection = { endpoint, config }
    },

    /**
     * The JSX attribute transform — C1 (#15).
     *
     * Thin by design: every decision that could be wrong lives in `stampSource`, which is a
     * pure function over strings and is tested as one. This hook only decides *whether* to
     * call it.
     *
     * Virtual modules are skipped by their leading NUL — the id is a plugin's private
     * namespace rather than a path on disk, so there is nothing for an agent to open even
     * when the contents happen to be JSX.
     */
    transform(code, id) {
      if (stamping === undefined) return null
      if (id.startsWith('\0')) return null
      if (!stamping.matches(id)) return null

      return stampSource(code, id, stamping.gitRoot)
    },

    /**
     * Injecting the tag here rather than asking the user to add a `<script>` is the whole
     * point of A1: user source never references dogear, so there is no import for a
     * bundler to follow into production.
     *
     * `order: 'post'` is separate from the plugin's `enforce: 'pre'` — Vite buckets
     * `transformIndexHtml` hooks by the hook's own order. A `pre` hook runs before Vite's
     * core HTML handling, which would route this inline module script through the
     * html-proxy machinery and turn one verbatim tag into a tag plus a generated module.
     * Running post emits exactly what is written below. The payload has no imports, so it
     * needs none of that processing.
     *
     * `injectTo` is independent of hook order, so `head-prepend` still puts dogear first
     * in document order — ahead of the app's own module, which is where B1's overlay will
     * want to be.
     */
    transformIndexHtml: {
      order: 'post',
      handler: () =>
        injection === undefined
          ? []
          : [
              {
                tag: 'script',
                attrs: {
                  type: 'module',
                  'data-dogear': SENTINEL,
                  // `src`, with no inline body at all — F4 (#34). A strict
                  // `script-src 'self'` blocks inline execution, and dogear failed silently
                  // with a console error that read like the host app's own bug. An external
                  // same-origin script needs no nonce, so dogear stays out of the host's CSP.
                  src: clientScriptSrc(injection.endpoint, injection.config),
                },
                injectTo: 'head-prepend',
              },
            ],
    },
  }
}

/**
 * Reject a bad `modifier` loudly, at config time.
 *
 * The mirror image of core's `resolveOptions`, which falls back to the default instead.
 * Same value, two audiences: here it is a developer reading a terminal while their dev
 * server starts, where a typo should be named; there it is a page load in a browser, where a
 * dev tool throwing has broken the app it exists to help inspect.
 *
 * E7 (#40) adds a third audience and it lands on the tolerant side: a bad `modifier` in
 * `.dogear/config.json` is warned about and dropped by ./config-file.ts rather than thrown
 * on. That file is committed, so whoever broke it is often not whoever is running the dev
 * server, and one person's typo must not stop everyone else's `npm run dev`. This function
 * still governs the *option*, which is the author's own code in the file they are editing.
 *
 * Validated in `configureServer` rather than in the factory, for the same reason
 * `normaliseEndpoint` is: a misconfigured dev tool must not be able to take down a
 * production build. `apply: 'serve'` already excludes the plugin from one, and throwing from
 * the factory would run before that had a chance to matter.
 */
function validateModifier(modifier: Modifier | undefined): Modifier | undefined {
  if (modifier === undefined || MODIFIERS.includes(modifier)) return modifier

  throw new Error(
    `dogear: modifier must be one of ${MODIFIERS.join(', ')}, received ` +
      JSON.stringify(modifier),
  )
}

export default dogear
