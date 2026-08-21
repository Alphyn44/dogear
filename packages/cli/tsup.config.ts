import { defineConfig } from 'tsup'

export default defineConfig({
  // Only the bin is an entry — run.ts is bundled into it. tsup preserves the shebang
  // on cli.ts, which is what makes dist/cli.js directly executable.
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  sourcemap: true,

  // Required, not cosmetic. ./src/mcp.ts reaches ./src/server.ts through a dynamic
  // `import()` so that `@modelcontextprotocol/sdk` stays out of the module graph of
  // `dogear hook` — which runs on every prompt the user types, under a 10s timeout with a
  // 2s budget asserted in test-built/hook.test.ts. Without code splitting tsup inlines the
  // dynamic import into the single output file, which hoists the SDK back to a top-level
  // import and puts its load time back on the hook's critical path. That regression is
  // silent apart from the budget assertion, so this line and that test are a pair.
  splitting: true,

  // Bundled rather than externalised: dogear-queue is a devDependency with no build of its
  // own, so it must be inlined here or the published bin would import a package that is not
  // installed. The MCP SDK is a real `dependency` and stays external, as tsup does by
  // default for anything in `dependencies`.
  noExternal: ['dogear-queue'],

  // No declarations at all for this one, and no tsc step either. dogear-cli is a bin
  // package with no `exports` field — nothing imports it as a library, so a .d.ts
  // would be dead weight. (This is also why it dodges the TypeScript 7 dts problem
  // that core and vite work around; see packages/core/tsup.config.ts.)
  dts: false,
})
