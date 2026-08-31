/**
 * The one copy of "what this Bot may and may not do", borrowed from the thing that enforces it.
 *
 * `describeBoundary` lives beside the compiler in `server/src/templates/boundary.ts` because the
 * sentences and the CEL clauses are two renderings of one `boundary:` block. A second copy here is
 * what this file exists to prevent: the consent screen is where somebody agrees to a ceiling, and
 * the Boundaries screen is where an administrator reads the same ceiling back afterwards. Two
 * hand-kept lists of sentences drift silently, and the day they do, one person consented to a
 * sentence nobody else will ever see. A wrong sentence here is not a typo, it is consent obtained
 * for something other than what was applied.
 *
 * A re-export module rather than a deep relative import at every call site, following
 * `lib/copilot/markers.ts`, which reaches across the same seam for the handoff sentinels. The
 * indirection is where these reasons get written down once.
 *
 * WHY THIS IMPORT IS ALLOWED, when `lib/templates/queries.ts` argues at length that the browser
 * must restate the template types rather than import them. That argument is about
 * `shared/bot-template.ts`, which imports the `yaml` package at run time and would put a second
 * parser in front of a stranger's file. This is a different shape: `describeBoundary` builds
 * strings and calls nothing, and nothing on this side of the seam decides anything — the clauses
 * are compiled and validated on the server at import time, and this is only the prose beside them.
 *
 * WHAT IT COSTS, measured rather than assumed. `boundary.ts` also imports `evaluateActionPolicy`
 * for the compiler's write-time validation, which reaches `cel-js`, which reaches `chevrotain`.
 * Rollup does NOT shake that away: the bare specifier resolves from the importing file's own
 * directory, so `server/node_modules/cel-js` is found and pulled in, and the app's eager entry
 * chunk grew by 144 kB when this import was added — 3,009.77 kB to 3,153.85 kB on `bun run build`,
 * or 902.73 kB to 945.49 kB gzipped.
 * The estimate that it would tree-shake was wrong, and it is written down here so the next person
 * does not have to rediscover it. The trade was taken deliberately — a consent screen and an
 * administrator's screen disagreeing about the same Bot is a worse failure than 141 kB — but it is
 * a trade with an obvious end: move `describeBoundary` into a module of its own that imports
 * nothing, and this file's cost goes to zero without any call site changing.
 */
export { describeBoundary } from "../../../../server/src/templates/boundary";
