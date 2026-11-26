/**
 * The production-leak sentinel, as dogear's hosts see it.
 *
 * This is deliberately a SECOND copy of the constant that lives in
 * packages/core/src/sentinel.ts, not an import of it. Three reasons, in order of weight:
 *
 * 1. Importing `dogear-core` by package name resolves through core's `exports` map to
 *    `dist/`, which would make `npm run typecheck` depend on a prior `npm run build`.
 *    Typecheck runs on every turn that touches a `.ts` file, so that is a permanent cost
 *    paid for a frozen twenty-character string.
 * 2. A relative import of core's source is not available either: each host's
 *    tsconfig.build.json sets `rootDir: "src"`, and declaration emit rejects anything above it.
 * 3. The hosts never import dogear's browser half; they emit a `<script>` tag. Keeping
 *    dogear-core unresolvable by name from the Node side keeps that boundary honest, and J4
 *    (#80) holds it as a source rule for `dogear-next`.
 *
 * Moved here from `dogear-vite` by J4, the first story whose second host needs it: Vite's
 * injected tag and Next's both carry it on `data-dogear`.
 *
 * The duplication is safe because ./sentinel.test.ts fails the moment the two literals
 * diverge. That test CAN reach across packages, because test files are outside every build,
 * so no `rootDir` applies to them.
 */
export const SENTINEL = '__DOGEAR_DEV_ONLY__'
