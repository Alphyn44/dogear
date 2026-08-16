import { findGitRoot } from '@dogear/queue'

import type { Agent } from './detect.js'
import { write } from './emit.js'
import type { Outcome } from './run.js'

/**
 * `dogear init` — the command adapter. E1 (#26).
 *
 * Structurally the twin of ./mcp.ts: resolve the repository here, hand the implementation
 * back as a continuation rather than importing it. ./scaffold.ts holds everything that
 * actually touches the repo.
 *
 * **The refusal is synchronous, and that is the second acceptance criterion.** A `dogear init`
 * outside a git repository has nowhere correct to put anything — the queue is
 * `<git-root>/.dogear/queue.json`, and every other reader in the system walks up for `.git` to
 * find it. Guessing `cwd` would produce a directory the dev server and the MCP server would
 * both fail to find, which is worse than refusing: the user would get a successful init and an
 * empty queue forever. Returning a `Result` rather than rejecting inside `run()` also keeps
 * this path free of the dynamic import, so it stays assertable in the fast suite.
 *
 * **The exit code is non-zero, unlike `dogear hook`'s.** The hook swallows a missing repo and
 * exits 0 because `UserPromptSubmit` reads a non-zero exit as a hook failure and exit 2 as
 * "erase what the user typed". Nothing constrains a command a human ran on purpose, and the
 * opposite need applies — someone who typed `dogear init` and got nothing deserves to know
 * why. Same reasoning as ./prune.ts and ./mcp.ts; do not harmonise the three with the hook.
 *
 * **The dynamic import stopped being prophylactic at E4, and E2 widened the gap again.**
 * ./scaffold.ts once imported `node:fs` and `node:path` and nothing else; it now reaches
 * ./gitignore.ts, which spawns git, and ./detect.ts, which walks the repository. Neither
 * belongs anywhere near `dogear hook` — it runs on every prompt the user types, under the 2s
 * budget in ../test-built/hook.test.ts — and this `import()` is the only thing keeping them
 * out of its module graph. It also means the CLI keeps exactly one shape for "command whose
 * implementation loads on demand", which tsup's `splitting: true` already exists to serve.
 */
export function init(cwd: string, args: readonly string[] = []): Outcome {
  // **Flags before the repository check**, so `dogear init --dryrun` outside a repo reports the
  // typo rather than the missing repo. The two failures are unrelated and the one the user can
  // fix is the one they mistyped.
  const flags = readFlags(args)
  if (flags.ok === false) return { output: flags.error, exitCode: 1 }

  // `cwd`, never `CLAUDE_PROJECT_DIR`. That variable exists because Claude Code spawns the
  // hook from the session's directory; a human typing this is standing where they mean.
  const gitRoot = findGitRoot(cwd)

  if (gitRoot === undefined) {
    return {
      output:
        `dogear: no git repository at or above ${cwd}. ` +
        'dogear init sets up .dogear/ at the git root, so it cannot run here.',
      exitCode: 1,
    }
  }

  // An `Async` outcome of the byte-producing kind — the opposite of `dogear mcp`, which enters
  // this variant because it must write *nothing*. `write()` is shared with ./cli.ts so both
  // paths obey the rule that an empty output means zero bytes rather than a blank line.
  return {
    run: async () =>
      write(
        (await import('./scaffold.js')).scaffold(gitRoot, {
          dryRun: flags.dryRun,
          agents: flags.agents,
          hook: flags.hook,
        }),
      ),
  }
}

/** The `--agent` values, and what each resolves to. `none` is the empty selection. */
const AGENTS = ['claude', 'cursor', 'vscode', 'none'] as const

type AgentFlag = (typeof AGENTS)[number]

/**
 * `dogear init`'s flags — E2 (#27).
 *
 * **An unrecognised argument is a failure, not something to ignore.** `--dry-run` exists
 * precisely so that a run changes nothing, so silently ignoring `--dryrun` would write to a
 * repository whose owner had just asked it not to. That asymmetry is the whole argument: an
 * over-strict parser costs a re-typed command, and a lenient one costs the thing the flag was
 * for.
 *
 * Parsed here rather than in ./run.ts, which reads the command and hands the rest over. E6
 * (#39) adds `--undo` to this list, and a per-command flag table in the dispatcher would put
 * every command's argument handling back in the file that exists to be short.
 *
 * **E3 (#28) added `--agent` and `--no-hook`, and they are what the brief's "init is
 * interactive" turned into.** The brief describes init *asking* which agent you use; the
 * command is non-interactive to its foundations — `plan()` may not write, every `plan()` runs
 * before any `apply()`, and `--dry-run` exists precisely because there is no point at which a
 * user can decline. A prompt fits nowhere in that, so detection guesses and these override it.
 * See the brief's Decisions log.
 *
 * **Only `import type` from ./detect.js.** It erases at compile time, so this file's module
 * graph is unchanged and `dogear hook` still loads none of the init implementation — which is
 * the property the dynamic `import()` above exists to protect.
 */
function readFlags(
  args: readonly string[],
):
  | { ok: true; dryRun: boolean; agents: readonly Agent[] | undefined; hook: boolean }
  | { ok: false; error: string } {
  let dryRun = false
  let hook = true

  // `undefined` until `--agent` is seen even once. E3 (#28): the flag *replaces* detection, so
  // "not given" and "given as none" have to stay distinguishable all the way to
  // `resolveWiring` — collapsing them into an empty array would make a plain `dogear init`
  // wire nothing at all.
  let agents: Agent[] | undefined

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }

    if (arg === '--no-hook') {
      hook = false
      continue
    }

    if (arg.startsWith('--agent=')) {
      const value = arg.slice('--agent='.length)

      if (!isAgentFlag(value)) {
        return {
          ok: false,
          error:
            `dogear init: unknown agent '${value}'. ` +
            `Valid values are ${AGENTS.join(', ')}.`,
        }
      }

      agents ??= []
      // `none` selects nothing and is not additive — repeating the flag around it would be a
      // contradiction the user cannot have meant, so the last word wins over the list so far.
      if (value === 'none') agents = []
      else if (!agents.includes(value)) agents.push(value)

      continue
    }

    return {
      ok: false,
      error:
        `dogear init: unrecognised argument '${arg}'. ` +
        'Flags are --dry-run (report and change nothing), --agent=<name> (repeatable; ' +
        `${AGENTS.join('|')}) and --no-hook (skip Claude Code's prompt hook).`,
    }
  }

  return { ok: true, dryRun, agents, hook }
}

function isAgentFlag(value: string): value is AgentFlag {
  return (AGENTS as readonly string[]).includes(value)
}
