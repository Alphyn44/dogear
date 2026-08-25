import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The scaffolding for H1 (#53): pack the three tarballs npm would publish, install them into
 * a project that shares nothing with this workspace, and drive it the way a user would.
 *
 * Kept beside the suite rather than inside it because every case shares one install — it is
 * the slowest thing in the repository by an order of magnitude, and running it per case would
 * turn a two-minute job into a twenty-minute one.
 */

/** The repository root. This file lives in `test-packed/`. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The three that publish, in the shape scripts/packaging.test.ts already uses. */
export const PUBLISHED = ['core', 'vite', 'cli'] as const
export type PublishedDir = (typeof PUBLISHED)[number]

/** `core` -> `dogear-core`. packaging.test.ts pins that this mapping is still true. */
export const npmName = (dir: PublishedDir): string => `dogear-${dir}`

interface Manifest {
  readonly name: string
  readonly version: string
  readonly peerDependencies?: Readonly<Record<string, string>>
}

export function manifestOf(dir: PublishedDir): Manifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8'),
  ) as Manifest
}

/**
 * How to spawn npm without a shell.
 *
 * `npm_execpath` first, and it is not an optimisation. What sits on PATH on Windows is
 * `npm.cmd`, and since Node 20.12 `execFile` refuses to spawn a `.cmd` at all without
 * `shell: true` — while `shell: true` does not quote the arguments it is handed, so a scratch
 * directory under `C:\Users\First Last\` would arrive as two of them. Under `npm run`, which
 * is how this suite is invoked by its own script and by CI, npm exports its own JS entry point
 * here, and `node <that>` needs neither a shim nor a shell.
 */
function npmCommand(args: readonly string[]): { file: string; argv: readonly string[] } {
  const execpath = process.env['npm_execpath']

  if (execpath !== undefined && execpath.endsWith('.js')) {
    return { file: process.execPath, argv: [execpath, ...args] }
  }

  if (process.platform !== 'win32') return { file: 'npm', argv: args }

  throw new Error(
    'npm_execpath is unset, and on Windows the npm on PATH is a .cmd that execFile cannot ' +
      'spawn without a shell. Run this suite as `npm run test:packed`.',
  )
}

export function runNpm(
  args: readonly string[],
  cwd: string,
  timeout = 600_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const { file, argv } = npmCommand(args)

  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...argv],
      // npm install's output is long enough to overflow the 1MB default, and the failure
      // reads as a killed process rather than as a truncated pipe.
      { cwd, timeout, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`npm ${args.join(' ')} failed:\n${stdout}\n${stderr}`))
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

export interface Packed {
  readonly name: string
  readonly version: string
  /** Absolute path to the tarball npm wrote. */
  readonly tarball: string
  /** Every path inside it, relative to the package root: `dist/cli.js`, `package.json`. */
  readonly files: readonly string[]
}

/** `npm pack --json`, narrowed to the fields this suite reads. */
interface PackReport {
  readonly name: string
  readonly version: string
  readonly filename: string
  readonly files: readonly { readonly path: string }[]
}

/**
 * Pack all three in one `npm pack`, and keep them together for the install afterwards.
 *
 * No version literal appears anywhere here, deliberately: the versions go up, and a literal
 * would need revving on every bump. `npm pack` packs whatever the manifests say, and the
 * tarball filenames come back in the `--json` report rather than being assembled from a
 * version string — so a pull request bumping 1.1 to 1.2 needs no edit in this directory.
 */
export async function packAll(destination: string): Promise<ReadonlyMap<string, Packed>> {
  const { stdout } = await runNpm(
    [
      'pack',
      ...PUBLISHED.flatMap((dir) => ['-w', npmName(dir)]),
      '--pack-destination',
      destination,
      '--json',
    ],
    REPO_ROOT,
  )

  const reports = JSON.parse(stdout) as readonly PackReport[]
  const packed = new Map<string, Packed>()

  for (const report of reports) {
    packed.set(report.name, {
      name: report.name,
      version: report.version,
      tarball: join(destination, report.filename),
      // npm has reported these both with and without the `package/` prefix that is actually
      // inside the archive. Normalising means the assertions read as the paths a consumer
      // sees after install.
      files: report.files.map(({ path }) => path.replace(/^package\//, '')),
    })
  }

  return packed
}

/**
 * Everything `packages/<dir>/dist` holds, named the way it would be inside a tarball.
 *
 * The comparison this feeds is name-agnostic on purpose. `dogear-cli` is code-split — tsup
 * emits `chunk-<hash>.js` beside `cli.js` — so any hand-written list of expected entries goes
 * stale the moment a chunk is added, split differently, or renamed by a rebuild.
 */
export function builtFiles(dir: PublishedDir): readonly string[] {
  const walk = (current: string, prefix: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((item) =>
      item.isDirectory()
        ? walk(join(current, item.name), `${prefix}${item.name}/`)
        : [`${prefix}${item.name}`],
    )

  return walk(join(REPO_ROOT, 'packages', dir, 'dist'), 'dist/')
}

export function tarballFor(
  packed: ReadonlyMap<string, Packed>,
  dir: PublishedDir,
): string {
  const entry = packed.get(npmName(dir))
  if (entry === undefined)
    throw new Error(`npm pack produced no tarball for ${npmName(dir)}`)
  return entry.tarball
}

/**
 * A project that shares nothing with this workspace, with the three tarballs installed.
 *
 * **Under tmpdir, not under this repository, and that is load-bearing.** `findGitRoot` walks
 * *up* for `.git`, so a fixture inside the workspace resolves to this repository — `dogear
 * init` would write into the real `.dogear/` and the plugin would serve this repo's queue,
 * proving nothing at all about an install.
 */
export async function createScratchProject(
  packed: ReadonlyMap<string, Packed>,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dogear-packed-'))

  // A bare `.git` directory rather than a real repository: `findGitRoot` only looks for the
  // entry, and E4's gitignore step then takes its degraded path, which is the arrangement
  // packages/cli/test-built/init.test.ts already documents.
  mkdirSync(join(root, '.git'))

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      { name: 'dogear-packed-fixture', private: true, version: '0.0.0', type: 'module' },
      null,
      2,
    )}\n`,
  )

  writeFileSync(
    join(root, 'index.html'),
    [
      '<!doctype html>',
      '<html>',
      '  <head><title>packed</title></head>',
      '  <body><div id="app"></div></body>',
      '</html>',
      '',
    ].join('\n'),
  )

  // No `defineConfig` and no app module. The fixture exists to prove that `dogear-vite`
  // resolves from an install and finds core's bundle, and both of those happen before a
  // single line of application code would run.
  writeFileSync(
    join(root, 'vite.config.js'),
    [
      "import { dogear } from 'dogear-vite'",
      '',
      'export default { plugins: [dogear()] }',
      '',
    ].join('\n'),
  )

  // Read rather than written down, so a peer bump in the manifest reaches this fixture on its
  // own. A bare `npm install vite` takes *latest*, which walks off `^8.0.0` the day vite 9
  // ships and fails as an unmet peer nobody changed.
  const vite = manifestOf('vite').peerDependencies?.['vite']
  if (vite === undefined) throw new Error('dogear-vite declares no vite peerDependency')

  // All three tarballs in ONE command. dogear-vite depends on dogear-core by range, and
  // passing them together is what lets the local core satisfy it instead of the registry —
  // the same thing the M5 smoke test relied on without saying so.
  await runNpm(
    [
      'install',
      '--no-save',
      '--no-audit',
      '--no-fund',
      ...PUBLISHED.map((dir) => tarballFor(packed, dir)),
      `vite@${vite}`,
    ],
    root,
  )

  return root
}

/**
 * Best-effort teardown, and best-effort is the whole point.
 *
 * Windows keeps handles on a node_modules tree for a while after the processes that touched
 * it have exited, and `rmSync`'s own retries do not reliably outlast that — an otherwise
 * clean run went red here in `afterAll` with EPERM. Both paths this removes are under tmpdir,
 * where the OS reclaims them anyway, so a warning is the honest response. Throwing would fail
 * the suite for a reason that has nothing to do with what it tested.
 */
export function discard(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn(`[test-packed] could not remove ${path}: ${String(error)}`)
  }
}

/** A free port, claimed and released. Vite has no port-0 mode, so one has to be chosen. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('could not claim a port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

export interface DevServer {
  readonly origin: string
  /**
   * Resolves once vite has actually exited, not once it has been signalled.
   *
   * The distinction is the difference between a green run and an EPERM in `afterAll`: the
   * scratch project's node_modules cannot be removed on Windows while a process that loaded
   * modules out of it is still winding down.
   */
  readonly stop: () => Promise<void>
}

/**
 * Vite's own CLI, spawned in the scratch project.
 *
 * A subprocess rather than an in-process `createServer`, because the resolution under test is
 * exactly the one a subprocess exercises: vite loads `vite.config.js` from the scratch root
 * and has to resolve `dogear-vite` from that project's node_modules, which then has to resolve
 * `dogear-core/package.json` from its own. Importing vite into this process instead would put
 * this repository's module graph underneath the thing being measured.
 */
export async function startDevServer(root: string): Promise<DevServer> {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`

  // `--host 127.0.0.1` rather than vite's default. Left alone, vite binds the name
  // `localhost`, which on Windows resolves to ::1 first — so a poll of 127.0.0.1 connects to
  // nothing and the whole case times out with a server that is plainly running in the log.
  // Naming the address makes the bind and the fetch the same fact instead of two guesses, and
  // it matches the port freePort() claimed on that interface.
  const child = spawn(
    process.execPath,
    [
      join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      child.once('close', () => resolve())
      child.kill()
    })

  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `vite exited with ${String(child.exitCode)} before serving:\n${log}`,
      )
    }
    try {
      const response = await fetch(`${origin}/`)
      if (response.ok) return { origin, stop }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop()
      throw new Error(`vite did not serve ${origin} within 90s:\n${log}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** Spawn the installed CLI the way everything `dogear init` writes spawns it. */
export function runInstalledCli(
  root: string,
  args: readonly string[],
): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join('node_modules', 'dogear-cli', 'dist', 'cli.js'), ...args],
      { cwd: root, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(
            new Error(`dogear ${args.join(' ')} did not terminate: ${error.message}`),
          )
          return
        }
        const exitCode =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ stdout, stderr, exitCode })
      },
    )
  })
}
