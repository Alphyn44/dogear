import type { DetectedApp, Detection, Manager } from './detect.js'

/**
 * What `dogear init` tells you to do yourself — E8 (#41), the brief's install step 6.
 *
 * **This writes nothing, and that is the ticket rather than a limitation of it.** Step 6 used
 * to say init *adds* `@dogear/vite` to devDependencies. Three things make writing it wrong:
 * both dogear packages are unpublished, so no range init could write would resolve; a manifest
 * edited without a matching lockfile update fails the next `npm ci`; and the edit accomplishes
 * nothing on its own, because the config's `import` fails until someone runs an install anyway.
 * Printing the command needs no version-derivation logic, cannot desync a lockfile, and is
 * correct the day the packages ship. See the brief's Decisions log.
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
 */

/** How many apps get a snippet before the rest are counted. Mirrors ./scaffold.ts's APP_CAP. */
const CAP = 5

/** `pnpm add -D`, and its two counterparts. */
const INSTALL: Record<Manager, string> = {
  npm: 'npm i -D',
  pnpm: 'pnpm add -D',
  yarn: 'yarn add -D',
}

/**
 * The trailing block, as report lines — or nothing at all.
 *
 * Empty in three cases, and none of them deserves a line saying so: a repository with no Vite
 * app (E2's `note:` already says the overlay will not load), a repository whose every app
 * already declares the plugin, and the same under `--dry-run`, which prints this identically
 * because it was never something being withheld.
 */
export function guidance(detection: Detection): readonly string[] {
  const unwired = detection.apps.filter((app) => app.plugin === 'absent')
  if (unwired.length === 0) return []

  const shown = unwired.slice(0, CAP).flatMap((app) => block(app, detection.manager))
  const hidden = unwired.length - Math.min(unwired.length, CAP)

  if (hidden === 0) return shown

  const rest =
    hidden === 1 ? '+ 1 more app needs the same' : `+ ${hidden} more apps need the same`

  return [...shown, '', rest]
}

/** One app's worth: what to put in its config, then what to install and where. */
function block(app: DetectedApp, manager: Manager): readonly string[] {
  return [
    '',
    `add dogear to ${app.config}:`,
    '',
    "  import { dogear } from '@dogear/vite'",
    '',
    '  export default defineConfig({',
    '    plugins: [dogear()],',
    '  })',
    '',
    `then, ${where(app)}: ${INSTALL[manager]} @dogear/vite`,
  ]
}

/**
 * Where to run the install — the package that owns the app, which is not always the app.
 *
 * An app scaffolded into a subdirectory of an existing package has no `package.json` of its
 * own, and naming its directory would tell the user to run an install somewhere that grows a
 * stray manifest. `manifestDir` is the directory the framework was read from, so the install
 * lands in the same package init already reported on.
 *
 * `undefined` — a repository with no manifest anywhere above the app — falls back to the root.
 * It is where the user is standing, and an install there creates the manifest that repository
 * was always going to need.
 */
function where(app: DetectedApp): string {
  const dir = app.manifestDir
  return dir === undefined || dir === '' ? 'at the repo root' : `in ${dir}`
}
