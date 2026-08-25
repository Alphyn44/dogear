import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
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
 * The package managers these suites install with — H6 (#58).
 *
 * Deliberately the same word list as `Manager` in packages/cli/src/detect.ts, so the fixture
 * and the code it is testing name the layouts the same way.
 */
export type Manager = 'npm' | 'pnpm' | 'yarn'

/** Which layout the install should produce. Only yarn offers the choice — see {@link Linker}. */
export type Linker = 'node-modules' | 'pnp'

/** The devDependency each non-npm manager is reached through, for the error message below. */
const MANAGER_PACKAGE: Readonly<Record<Exclude<Manager, 'npm'>, string>> = {
  pnpm: 'pnpm',
  yarn: '@yarnpkg/cli-dist',
}

/**
 * How to spawn a package manager without a shell.
 *
 * **npm: `npm_execpath` first, and it is not an optimisation.** What sits on PATH on Windows is
 * `npm.cmd`, and since Node 20.12 `execFile` refuses to spawn a `.cmd` at all without
 * `shell: true` — while `shell: true` does not quote the arguments it is handed, so a scratch
 * directory under `C:\Users\First Last\` would arrive as two of them. Under `npm run`, which
 * is how this suite is invoked by its own script and by CI, npm exports its own JS entry point
 * here, and `node <that>` needs neither a shim nor a shell.
 *
 * **pnpm and yarn: the same trap, and no `npm_execpath` to escape it with.** `pnpm.cmd` and
 * `yarn.cmd` are `.cmd` shims exactly as npm's is, and `npm_execpath` names whichever manager
 * invoked the suite — npm — so it cannot answer for the other two. They are devDependencies
 * instead, reached by `node <their own JS entry>`: no shim, no shell, no PATH, and a version
 * pinned in this repository's lockfile rather than whatever the machine happens to have.
 *
 * The entry is **read from the installed manifest's `bin` field**, never written down here. A
 * hard-coded `bin/pnpm.cjs` is a guess that goes stale on a major bump, and it would fail as a
 * missing-file error naming a path rather than as the dependency problem it is.
 */
function managerCommand(
  manager: Manager,
  args: readonly string[],
): { file: string; argv: readonly string[] } {
  if (manager !== 'npm')
    return { file: process.execPath, argv: [binOf(manager), ...args] }

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

/**
 * The JS file a manager's `bin` field points at, resolved from this repository's install.
 *
 * `createRequire` first, then the literal path under the repository root: a package whose
 * `exports` map does not publish `./package.json` cannot be resolved by specifier, and both
 * managers are direct devDependencies of a repository that installs with npm, so the second
 * form is reliable here even though it would not be in shipped code.
 */
function binOf(manager: Exclude<Manager, 'npm'>): string {
  const name = MANAGER_PACKAGE[manager]
  const require = createRequire(import.meta.url)

  let manifestPath: string
  try {
    manifestPath = require.resolve(`${name}/package.json`)
  } catch {
    manifestPath = join(REPO_ROOT, 'node_modules', name, 'package.json')
  }

  if (!existsSync(manifestPath)) {
    throw new Error(
      `${manager} is reached through the ${name} devDependency and it is not installed. ` +
        `Run \`npm i -D ${name}\` at the repository root.`,
    )
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly bin?: string | Readonly<Record<string, string>>
  }

  // `bin` is a string for a single-binary package and a map otherwise. Prefer the entry named
  // for the manager itself — pnpm's map also carries `pnpx`, which is not what we want — and
  // fall back to the first entry when the map names it something else.
  const entry =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : (manifest.bin?.[manager] ?? Object.values(manifest.bin ?? {})[0])
  if (entry === undefined)
    throw new Error(`${name} declares no bin to run ${manager} with`)

  return join(dirname(manifestPath), entry)
}

/** Run any of the three. {@link runNpm} is the npm-bound form the rest of this file uses. */
export function runManager(
  manager: Manager,
  args: readonly string[],
  cwd: string,
  timeout = 600_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const { file, argv } = managerCommand(manager, args)

  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...argv],
      // npm install's output is long enough to overflow the 1MB default, and the failure
      // reads as a killed process rather than as a truncated pipe.
      { cwd, timeout, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${manager} ${args.join(' ')} failed:\n${stdout}\n${stderr}`))
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

export function runNpm(
  args: readonly string[],
  cwd: string,
  timeout = 600_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return runManager('npm', args, cwd, timeout)
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
 *
 * **The manager and linker default to npm's, so H1's suite is unaffected** — H6 (#58) added
 * them. The install command is the only thing that varies; everything written above it is the
 * same project whichever tool installs into it, which is the point of comparing them.
 */
export async function createScratchProject(
  packed: ReadonlyMap<string, Packed>,
  { manager = 'npm', linker = 'node-modules' }: ScratchOptions = {},
): Promise<string> {
  // Per-manager prefix so concurrent legs cannot be mistaken for each other in a stack trace,
  // and so a leaked directory says which install left it behind.
  //
  // **`realpathSync.native`, and on Windows it is what keeps vite alive.** The GitHub
  // windows-latest runner's TEMP sits under an 8.3 short name (`C:\Users\RUNNER~1\…`, because
  // `runneradmin` is too long for the legacy form), and `tmpdir()` hands that spelling straight
  // through. vite then watches it, ReadDirectoryChangesW reports the *long* name back, and
  // libuv asserts that what it was given is a prefix of what it got:
  //
  //     Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
  //
  // which aborts the process with 0xC0000409 *after* it has printed its ready banner. The symptom
  // is a dev server that starts, says it is listening, and dies on the first file event.
  // `.native` rather than the JS `realpathSync` because only the OS call expands a short name;
  // the JS one resolves symlinks and leaves `RUNNER~1` exactly as it found it. On macOS this is
  // the `/var` → `/private/var` resolution the same call gives for free, which is the same class
  // of bug one platform over.
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), `dogear-packed-${manager}-`)),
  )

  // A bare `.git` directory rather than a real repository: `findGitRoot` only looks for the
  // entry, and E4's gitignore step then takes its degraded path, which is the arrangement
  // packages/cli/test-built/init.test.ts already documents.
  mkdirSync(join(root, '.git'))

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dogear-packed-fixture',
        private: true,
        version: '0.0.0',
        type: 'module',
        ...resolutionsFor(manager, packed),
      },
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

  // Yarn's linker is a project setting, so it has to be on disk before the install runs.
  //
  // `enableImmutableInstalls` is the one that would otherwise pass here and fail in CI:
  // Berry turns it on by itself whenever `CI` is set, and `yarn add` necessarily writes a
  // lockfile, so the install dies with YN0028 on a runner and nowhere else. This project has
  // no lockfile to protect — it is built from scratch for one assertion and deleted after.
  //
  // Telemetry off for the same reason nothing else in this repository phones home.
  if (manager === 'yarn') {
    writeFileSync(
      join(root, '.yarnrc.yml'),
      [
        `nodeLinker: ${linker}`,
        'enableImmutableInstalls: false',
        'enableTelemetry: false',
        '',
      ].join('\n'),
    )
  }

  // All three tarballs in ONE command. dogear-vite depends on dogear-core by range, and
  // passing them together is what lets the local core satisfy it instead of the registry —
  // the same thing the M5 smoke test relied on without saying so.
  const tarballs = PUBLISHED.map((dir) => specifierFor(manager, packed, dir))

  await runManager(manager, [...installVerb(manager), ...tarballs, `vite@${vite}`], root)

  return root
}

/**
 * Yarn's `resolutions` field, and only Yarn's — H6 (#58).
 *
 * **Yarn will not use a `file:` locator to satisfy another package's semver range.** Pass all
 * three tarballs and `dogear-vite`'s `dogear-core: ^0.1.0` still goes to the registry, so the
 * project gets the local core at the top level and a *second*, published one nested underneath
 * the plugin. Measured, not assumed: top-level `0.1.1` with `0.1.0` under `dogear-vite/`, and
 * with this field the nested copy is gone. npm and pnpm both dedupe it without being asked.
 *
 * **This is a property of installing from local tarballs, not of dogear.** Nobody installs the
 * published packages this way: a real `yarn add -D dogear-vite` resolves both from the registry
 * and gets one copy. Without this the yarn legs would test Yarn's `file:` protocol semantics
 * rather than whether the committed CLI path resolves, and they would do it by failing the one
 * assertion H1's npm leg uses to enforce G2's caret-range decision — a red that means nothing
 * here and everything there.
 */
function resolutionsFor(
  manager: Manager,
  packed: ReadonlyMap<string, Packed>,
): { readonly resolutions?: Readonly<Record<string, string>> } {
  if (manager !== 'yarn') return {}

  return {
    resolutions: {
      [npmName('core')]: `file:${tarballFor(packed, 'core').replace(/\\/g, '/')}`,
    },
  }
}

/**
 * How to name a local tarball to the manager doing the installing.
 *
 * npm and pnpm take a bare path. **Yarn does not**, and the failure is not subtle: it reads an
 * unprefixed argument as a registry range, so `.../dogear-core-0.1.1.tgz` becomes a package name
 * and Berry goes to registry.yarnpkg.com asking for a URL-encoded Windows path. `file:` alone is
 * still rejected — `yarn add` requires the `package-name@range` form and says so — which leaves
 * `dogear-core@file:...` as the one spelling that works. Established by running all three
 * against a real Berry, not from its documentation.
 *
 * Forward slashes because the specifier is a *range*, not a path Node will resolve: a Windows
 * backslash inside one is an escape character to the parser reading it.
 */
function specifierFor(
  manager: Manager,
  packed: ReadonlyMap<string, Packed>,
  dir: PublishedDir,
): string {
  const tarball = tarballFor(packed, dir)
  if (manager !== 'yarn') return tarball

  return `${npmName(dir)}@file:${tarball.replace(/\\/g, '/')}`
}

/** Options for {@link createScratchProject}. Both default to what npm does — H6 (#58). */
export interface ScratchOptions {
  readonly manager?: Manager
  /** Only `yarn` honours this; npm and pnpm have no PnP mode in play here. */
  readonly linker?: Linker
}

/**
 * The verb and flags that mean "add these, and do not write it down".
 *
 * Each manager spells the same intent differently, and the flags are not cosmetic: without
 * them every install writes a lockfile and a manifest entry into a scratch project that exists
 * for one assertion, and yarn additionally treats a dirty lockfile as a CI failure.
 *
 * pnpm gets `--ignore-workspace` because the scratch project lives under `tmpdir`, and pnpm
 * walks *up* for a `pnpm-workspace.yaml` exactly as `findGitRoot` walks up for `.git` — a
 * developer whose temp directory sits inside one would otherwise get a different install from
 * the same test.
 */
function installVerb(manager: Manager): readonly string[] {
  switch (manager) {
    case 'npm':
      return ['install', '--no-save', '--no-audit', '--no-fund']
    case 'pnpm':
      return ['add', '--ignore-workspace', '--reporter=append-only']
    case 'yarn':
      return ['add']
  }
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
