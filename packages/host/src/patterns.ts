/**
 * Which files the transform touches by default — C1 (#15), and the same pair the brief's
 * `.dogear/config.json` names. Shared by both hosts since J2 (#78), so "the files stamped are
 * the ones the configuration includes, as under Vite" starts from one list.
 *
 * A module of its own, apart from ./stamp.ts, because `dogear-next`'s config wrapper needs these
 * and must not import the transform: esbuild keeps an external import it cannot prove free of
 * side effects, so reaching ./stamp.ts would load Oxc's native binding on every evaluation of
 * `next.config`.
 *
 * JSX-only by design. A `.js` holding JSX is not parsed as JSX by Oxc, and forcing it would
 * mean dogear deciding a file's language against the project's own toolchain. The brief lists
 * `.js` files among the places the attribute legitimately does not reach; they get the
 * selector floor (C3) instead.
 */
export const DEFAULT_INCLUDE: readonly string[] = ['**/*.jsx', '**/*.tsx']

/**
 * Never transform dependencies. Stamping them would point the agent at code inside
 * `node_modules` that it has no business editing, and a linked workspace dependency is
 * already covered by its own dev server.
 */
export const DEFAULT_EXCLUDE: readonly string[] = ['**/node_modules/**']
