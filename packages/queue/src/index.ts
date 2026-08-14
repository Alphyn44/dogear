/**
 * `@dogear/queue` — the shared home for everything that touches
 * `<git-root>/.dogear/queue.json`.
 *
 * **Why this package exists.** Before D1 there was one writer (the Vite plugin) and one
 * reader (the CLI's hook), and the overlap was a fourteen-line `findGitRoot` duplicated
 * behind a parity test. D1 adds a second writer — the MCP server resolves and prunes —
 * and the overlap becomes the atomic write itself, whose two concurrency rules lose a
 * user's annotations *silently* if two implementations ever disagree. At that size, with
 * two consumers, a shared module is cheaper than a guarded copy.
 *
 * **Why it is source-only.** `exports` points at `src/index.ts`, there is no build, and
 * nothing is published. CI runs `npm run typecheck` *before* `npm run build`, and
 * `stop-verify.sh` runs it on every TypeScript turn — so a package whose types came from
 * `dist/` would make typechecking depend on a prior build, which is exactly the trap
 * `examples/react-app` is already documented as falling into. Both consumers list this as
 * a **devDependency** and their bundlers inline it, so no published artifact gains a
 * dependency and the three-package install story is unchanged.
 */

export { findGitRoot } from './git-root.js'

export type { Annotation, AnnotationInput, StampOptions } from './annotation.js'
export { createUuidv7, stampAnnotation, uuidv7 } from './annotation.js'

export type {
  AppendResult,
  PruneResult,
  Queue,
  QueueRead,
  ResolveResult,
  StoredAnnotation,
} from './queue.js'
export {
  QUEUE_DIR,
  QUEUE_VERSION,
  appendToQueue,
  pendingOnly,
  pruneQueue,
  queuePathFor,
  readQueue,
  resolveInQueue,
  tempPathFor,
  tryReadQueue,
  withApp,
  writeQueue,
} from './queue.js'
