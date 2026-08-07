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

  // No declarations at all for this one, and no tsc step either. @dogear/cli is a bin
  // package with no `exports` field — nothing imports it as a library, so a .d.ts
  // would be dead weight. (This is also why it dodges the TypeScript 7 dts problem
  // that core and vite work around; see packages/core/tsup.config.ts.)
  dts: false,
})
