import type { RegistryEnv } from '@dogear/queue'
import {
  registerProject,
  registryKey,
  registryPath,
  shortenHome,
  tryReadRegistry,
} from '@dogear/queue'

import type { Step } from './scaffold.js'

/**
 * This repository is in `~/.dogear/projects.json` — E5 (#30), install step 7.
 *
 * **The only step that writes outside the repository**, which is why it runs last. Every
 * other step contributes to the feature itself; this one contributes to `dogear status`
 * knowing the repo exists. E3's ordering rule — a failure part-way through leaves the half
 * carrying the whole feature set done — puts a step with no feature at the end.
 *
 * **It writes the repository's existence and nothing else.** The origin of a dev server
 * cannot be known here: there is no dev server when init runs, and Vite settles on a port
 * only once it is listening. `@dogear/vite` fills that half in, and either half may create
 * the entry — see `registerProject` and `registerServer`.
 *
 * **A factory, like E3's three steps**, because the registry path depends on `DOGEAR_HOME`
 * and a step that read `process.env` at module scope could not be tested without mutating
 * the environment of every other suite in the worker.
 *
 * E6 (#39) takes this back out, and gets the easiest teardown of the six: the entry is keyed
 * by {@link registryKey}, so removal is a single key delete with no markers to scan for and
 * no formatting to preserve — the opposite of ./rules.ts and ./hook-config.ts.
 */
export function createRegisterStep(env: RegistryEnv): Step {
  return {
    name: 'project-registry',
    plan: (root) => {
      const path = registryPath(env)

      // Tolerant, because `plan()` must never throw and this one runs on every init — a
      // registry broken by another repository's half-written state would otherwise take out
      // an init that has nothing to do with it. `apply()` below uses the strict reader, which
      // is the rule working as intended: this read only decides whether there is work.
      const read = tryReadRegistry(path)

      if (!read.ok) {
        // A note, not a change: init can see the problem and must not repair it by guessing.
        // The file is machine-level state that may hold other repositories' entries, and
        // overwriting it to fix this one would lose them.
        return {
          notes: [
            `${shortenHome(path)} could not be read, so this repository was not ` +
              `registered and \`dogear status\` will not list it: ${read.reason}. ` +
              'Fix or delete that file and re-run.',
          ],
        }
      }

      // Idempotency is the absence of a code path. A repository the plugin registered but
      // init never did still has work to do here — it has no `initialisedAt` — which is why
      // this asks for that field rather than for the key being present.
      if (read.registry.projects[registryKey(root)]?.initialisedAt !== undefined) {
        return undefined
      }

      return {
        change: {
          summary: `registered this repository in ${shortenHome(path)}`,
          // Re-read and re-write, as every other step's `apply` does: several minutes of
          // planning may separate the two, and another dev server may have registered since.
          // `registerProject` re-reads internally and is a no-op if it lost the race.
          apply: () => registerProject(path, root),
        },
      }
    },
  }
}
