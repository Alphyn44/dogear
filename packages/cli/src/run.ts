/**
 * Argument handling for the `dogear` CLI, kept separate from the executable so it can
 * be tested without a subprocess. ./cli.ts is the thin bin wrapper that calls this and
 * exits; everything with a decision in it lives here.
 */

/**
 * TODO(dogear): none of these are implemented. `mcp` is D1, `prune` is D6, `init` is
 * E1 and `status` is E5. Listing them now is deliberate — an unknown command and an
 * unimplemented one are different failures, and the CLI should be able to say which.
 */
export const COMMANDS = ['init', 'mcp', 'prune', 'status'] as const

export type Command = (typeof COMMANDS)[number]

export interface Result {
  readonly output: string
  readonly exitCode: number
}

export function usage(): string {
  return [
    'dogear — point at an element, comment on it, hand it to your agent',
    '',
    'Usage: dogear <command>',
    '',
    'Commands:',
    '  init     Scaffold this repo: config, gitignore, agent wiring',
    '  mcp      Run the MCP server over stdio',
    '  prune    Drop resolved items from the queue',
    '  status   What is running and what is pending, across all repos',
    '',
    'No command is implemented yet. See https://github.com/Alphyn44/dogear/milestones',
  ].join('\n')
}

export function run(argv: readonly string[]): Result {
  const [command] = argv

  if (command === undefined || command === '--help' || command === '-h') {
    return { output: usage(), exitCode: 0 }
  }

  if (!isCommand(command)) {
    return { output: `dogear: unknown command '${command}'\n\n${usage()}`, exitCode: 1 }
  }

  return {
    output: `dogear: '${command}' is recognised but not implemented yet`,
    exitCode: 1,
  }
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value)
}
