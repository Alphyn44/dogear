import type { DetectedApp, Detection, Host, Manager } from './detect.js'

/**
 * What `dogear init` tells you to do yourself — E8 (#41), the brief's install step 6.
 *
 * **This writes nothing, and that is the ticket rather than a limitation of it.** Step 6 used
 * to say init *adds* `dogear-vite` to devDependencies. Two things make writing it wrong, and
 * neither expires: a manifest edited without a matching lockfile update fails the next
 * `npm ci`, and the edit accomplishes nothing on its own, because the config's `import` fails
 * until someone runs an install anyway. Printing the command needs no version-derivation
 * logic and cannot desync a lockfile.
 *
 * A third reason held only until G4 published the packages — no range init could write would
 * have resolved — and it is recorded here because it is the one that made the decision look
 * temporary. It was not: the other two are why this still prints rather than writes. See the
 * brief's Decisions log.
 *
 * **So this is a runner phase, not a {@link import('./scaffold.js').Step}** — the same shape,
 * and for the same reason, as E2's detection remarks: nothing plans it, nothing applies it,
 * and there is no idempotency to keep in sync because there is no state to become idempotent
 * about. The `Step` list stays a list of things that change the repository. E6 (#39) inherits
 * no teardown from here for the same reason.
 *
 * **The `vite.config` body is a fixed template and is not tailored.** A config can be a
 * function, a `defineConfig` call, a merge of three environment-specific objects, or
 * TypeScript that only compiles under the repository's own paths — rewriting it safely means
 * parsing it, and a wrong guess is a dev server that will not start. Only the heading's path
 * is real, which is what makes three snippets in a monorepo tell each other apart. The same
 * reasoning excludes the framework plugin from the body: `plugins: [dogear(), react()]` reads
 * closer to the user's actual file and asserts an import that may not exist under that name,
 * which makes a copyable snippet subtly wrong.
 *
 * **J5 (#81) added Next, and changed none of the above.** A Next app gets a `next.config`
 * wrapper in place of a `plugins` entry, and `dogear-next` in place of `dogear-vite`; init still
 * writes neither, for E8's two reasons, which apply to `next.config` and its manifest unchanged.
 */

/** How many apps get a snippet before the rest are counted. Mirrors ./scaffold.ts's APP_CAP. */
const CAP = 5

/** `pnpm add`, and its two counterparts. Reached through {@link installCommand}. */
const INSTALL: Record<Manager, string> = {
  npm: 'npm i',
  pnpm: 'pnpm add',
  yarn: 'yarn add',
}

/** The dependency map an install writes to. See {@link installCommand}. */
export type Field = 'dev' | 'runtime'

/**
 * The install for a package, as the user should type it. A dev dependency unless told otherwise.
 *
 * Exported since H6 (#58) so ./scaffold.ts's `dogear-cli` remark names the manager the repository
 * actually uses. It said `npm i -D` to every repository until then, including the pnpm and yarn
 * ones this module already got right.
 *
 * **`-w` at a pnpm workspace root, since #85.** pnpm 9 refuses the add there without it, and 10
 * and 11 accept either form, so the flag is never wrong where it is added. It needs pnpm to be
 * the manager as well: a workspace file with no lockfile yet still resolves to npm, by
 * `managerOf`'s rule in ./detect.ts, and npm has no such flag.
 *
 * **`runtime` exists for `dogear-next` alone (J5, #81)**, and it is the one place dogear asks to
 * be installed as a runtime dependency. `next start` loads `next.config` in production, so a
 * config that imports `dogear-next` cannot load wherever devDependencies were left out. See the
 * brief's Decisions log.
 */
export function installCommand(
  manager: Manager,
  pnpmWorkspaceRoot: boolean,
  field: Field = 'dev',
): string {
  const flags = [
    ...(field === 'dev' ? ['-D'] : []),
    ...(manager === 'pnpm' && pnpmWorkspaceRoot ? ['-w'] : []),
  ]
  return [INSTALL[manager], ...flags].join(' ')
}

/**
 * The trailing block, as report lines — or nothing at all.
 *
 * Empty in three cases, and none of them deserves a line saying so: a repository with no app
 * (E2's `note:` already says the overlay will not load), a repository whose every app is
 * already wired, and the same under `--dry-run`, which prints this identically because it was
 * never something being withheld.
 *
 * Since J5 (#81) an app is a Vite app or a Next app, and each gets its own host's block from
 * {@link HOSTS}. A repository with one of each gets two blocks.
 */
export function guidance(detection: Detection): readonly string[] {
  const unwired = detection.apps.filter(
    (app) => app.plugin === 'absent' || !app.configured,
  )
  if (unwired.length === 0) return []

  const shown = unwired.slice(0, CAP).flatMap(block)
  const hidden = unwired.length - Math.min(unwired.length, CAP)

  if (hidden === 0) return shown

  const rest =
    hidden === 1 ? '+ 1 more app needs the same' : `+ ${hidden} more apps need the same`

  return [...shown, '', rest]
}

/**
 * One app's worth: what to put in its config, then what to install and where — but only the
 * halves that are actually missing.
 *
 * The two are independent, which G3 (#44) found by doing them one at a time. `npm i -D
 * dogear-vite` satisfies the second and leaves the first exactly as it was, so an app that
 * has the package and not the plugin call needs the snippet and emphatically does not need
 * telling to install what it already has.
 *
 * The install command is the app's own manager since #75, read from the lockfile nearest its
 * package. The repository's root lockfile answered for every app before, and a repository with
 * no root `package.json` has no root lockfile, so a pnpm app in `web/` was told to use npm.
 */
function block(app: DetectedApp): readonly string[] {
  const lines: string[] = []
  const { snippet, name, field } = HOSTS[app.host]

  if (!app.configured) {
    lines.push('', `add dogear to ${app.config}:`, '', ...snippet)
  }

  if (app.plugin === 'absent') {
    // `then,` only reads as a sequel to the snippet above it. Standing alone it is an
    // instruction in its own right, and says so.
    const lead = app.configured ? `install it ${where(app)}` : `then, ${where(app)}`
    lines.push(
      '',
      `${lead}: ${installCommand(app.manager, app.pnpmWorkspaceRoot, field)} ${name}`,
    )
  }

  return lines
}

/**
 * Each host's fixed snippet, package and dependency field.
 *
 * **Next's snippet is fixed for the reason Vite's is**, see the header. It is ESM because that
 * is what `create-next-app` writes for both `next.config.ts` and `--js`'s `next.config.mjs`, and
 * it names `nextConfig` because that is the variable both of those declare. A `.js` config could
 * be either module format, so tailoring by extension would guess, and a wrong guess pasted into
 * a config is a dev server that will not start.
 *
 * **`dogear-next` installs as a runtime dependency**, the inverse of `dogear-vite`. See
 * {@link installCommand}.
 */
const HOSTS: Record<
  Host,
  { readonly snippet: readonly string[]; readonly name: string; readonly field: Field }
> = {
  vite: {
    snippet: [
      "  import { dogear } from 'dogear-vite'",
      '',
      '  export default defineConfig({',
      '    plugins: [dogear()],',
      '  })',
    ],
    name: 'dogear-vite',
    field: 'dev',
  },
  next: {
    snippet: [
      "  import { withDogear } from 'dogear-next'",
      '',
      '  export default withDogear(nextConfig)',
    ],
    name: 'dogear-next',
    field: 'runtime',
  },
}

/**
 * Where to run the install — the package that owns the app, which is not always the app.
 *
 * An app scaffolded into a subdirectory of an existing package has no `package.json` of its
 * own, and naming its directory would tell the user to run an install somewhere that grows a
 * stray manifest. `manifestDir` is the directory the framework was read from, so the install
 * lands in the same package init already reported on.
 *
 * **With no manifest anywhere above the app, the install goes in the app's own directory** (#75).
 * This used to fall back to the root, on the grounds that an install there "creates the manifest
 * that repository was always going to need". #75 was the counterexample: a Go repository with its
 * frontend in `web/` was never going to need a root `package.json`, and being told to create one
 * is how a second, empty package ends up beside the real one. An install in the app's directory
 * creates the manifest that *app* needs. An app whose config sits at the root has only the root
 * to be told, and there the root is the app's own package.
 */
function where(app: DetectedApp): string {
  const dir = app.manifestDir ?? app.dir
  return dir === '' ? 'at the repo root' : `in ${dir}`
}
