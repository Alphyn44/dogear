/**
 * The production-leak sentinel, as @dogear/vite sees it.
 *
 * This is deliberately a SECOND copy of the constant that lives in
 * packages/core/src/sentinel.ts, not an import of it. Three reasons, in order of weight:
 *
 * 1. Importing `@dogear/core` by package name resolves through core's `exports` map to
 *    `dist/`, which would make `npm run typecheck` depend on a prior `npm run build`.
 *    Typecheck runs on every turn that touches a `.ts` file, so that is a permanent cost
 *    paid for a frozen twenty-character string.
 * 2. A relative import of core's source is not available either: tsconfig.build.json sets
 *    `rootDir: "src"`, and declaration emit rejects anything above it.
 * 3. The plugin never imports dogear's browser half — it emits a `<script>` tag. Keeping
 *    @dogear/core unresolvable from the Node-side plugin keeps that boundary honest.
 *
 * The duplication is safe because ./sentinel.test.ts fails the moment the two literals
 * diverge. That test CAN reach across packages, because test files are excluded from
 * tsconfig.build.json and from the tsup entry, so no `rootDir` applies to them.
 */
export const SENTINEL = '__DOGEAR_DEV_ONLY__'
