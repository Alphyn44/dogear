import { statSync, writeFileSync } from 'node:fs'

import { CONFIG_FILE, QUEUE_DIR, QUEUE_VERSION, configPathFor } from '@dogear/queue'

import type { Step } from './scaffold.js'

/**
 * `.dogear/config.json` exists — E4 (#29), the committed half of the directory.
 *
 * **It holds `{ "version": 1 }` and nothing else, and that is the decision, not a stub.**
 * The brief's Config block lists every key dogear recognises — `modifier`, `endpoint`,
 * `hosts` and the rest — and writing that block out with today's values was the obvious
 * alternative. It is wrong for a reason that only shows up later: a config file that
 * restates a default *pins* it. Change `DEFAULT_HOSTS` in a future release and every repo
 * that ever ran `dogear init` keeps the old list forever, having never expressed an
 * opinion about it. An absent key means "whatever dogear thinks", which is what a user who
 * did not edit this file actually wants. See the brief's Decisions log.
 *
 * `version` is the one key worth writing, because it is the only one whose absence is
 * ambiguous: E7's (#40) reader needs to tell "a config from a dogear that predates this schema"
 * from "a config that opted into every default".
 *
 * **Any regular file at this path satisfies the step**, whatever is in it — including
 * empty, including unparseable. This is `@dogear/queue`'s "reads may tolerate, writes must
 * refuse" rule reaching one level up: the file is a project decision someone may have
 * hand-edited, and an init that rewrote a broken config would destroy the evidence of
 * whatever broke it. A parse error belongs to whoever *reads* the file (E7), where there
 * is a running dev server and a developer to tell.
 */
export const configFile: Step = {
  name: 'config-file',
  plan: (root) => {
    const path = configPathFor(root)
    if (kindOf(path) === 'file') return undefined

    return {
      change: {
        summary: `created ${QUEUE_DIR}/${CONFIG_FILE}`,
        apply: () => {
          // Re-checked rather than trusted, the same way ./queue-dir.ts re-checks: a
          // directory here produces `EISDIR` from `writeFileSync`, which names neither the
          // path nor a way out.
          if (kindOf(path) === 'other') {
            throw new Error(
              `${QUEUE_DIR}/${CONFIG_FILE} exists at ${root} but is not a regular file. ` +
                "Remove it and re-run — dogear keeps this repository's settings there.",
            )
          }

          // Trailing newline, for the same reason `writeQueue` writes one: `cat
          // .dogear/config.json` is a design goal, and a file without it runs into the
          // next shell prompt.
          writeFileSync(
            path,
            `${JSON.stringify({ version: QUEUE_VERSION }, null, 2)}\n`,
            'utf8',
          )
        },
      },
    }
  },
}

/**
 * What is at `path`, without ever throwing.
 *
 * **Planning must not throw**, and this is the file where that stops being theoretical.
 * Every step's `plan()` runs before any `apply()`, so this one inspects
 * `.dogear/config.json` in the repository where `.dogear` is a *regular file* — the case
 * ../src/scaffold.test.ts pins. `statSync` raises `ENOTDIR` there, which
 * `throwIfNoEntry: false` does not suppress: that option covers `ENOENT` only. Unhandled,
 * a well-reported failure from the step above turns into a stack trace from this one.
 */
function kindOf(path: string): 'file' | 'other' | 'missing' {
  try {
    return statSync(path).isFile() ? 'file' : 'other'
  } catch {
    return 'missing'
  }
}
