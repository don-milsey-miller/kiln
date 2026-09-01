import "server-only";

/**
 * WHERE planning content lives — and nothing that reads it.
 *
 * ⚠️ **THIS IS A SEPARATE DOOR FROM `content.js` BECAUSE IT ADMITS A SECOND CONSUMER, AND IT CAN ONLY
 * DO THAT SAFELY BY HOLDING NOTHING ELSE.** The content adapters admit the reader alone, and the
 * justification is DEC-0019's freshness contract: a second importer of `lintProject` is a second
 * place a read can happen outside `connection()`. That justification does not reach a path
 * calculation. `resolveContentRoot` opens nothing, parses nothing and caches nothing — it applies
 * #70's one rule and returns a string — so admitting `/events` here widens no read surface at all.
 *
 * The alternative was to list `events/route.js` as a permitted consumer of `content.js`, which would
 * have handed the route `lintProject` and `readActivatedTypes` in order to give it a directory name.
 * Splitting the module is what keeps the widening proportionate to what is actually needed.
 *
 * ⚠️ **THE ROUTE NEEDS IT BECAUSE THE WATCHER AND THE READER MUST AGREE.** They resolved
 * independently until 2026-08-31 — the reader through this resolver, the route through its own
 * `process.cwd()` fallback — and in a consumer install those two disagree: the page reads the
 * project's content while the watcher watches the tool's own. One resolver, both callers (#47, #70).
 *
 * ⚠️ **ONE NAME, BECAUSE THE ARGUMENT ABOVE ONLY COVERS ONE NAME.** `resolveInContentRoot` was here
 * too, carried over when these moved out of `content.js`, and neither permitted consumer calls it.
 * The case for a second consumer is that this module holds nothing but a path calculation — so every
 * export it does not need is surface that case has to keep being true for. `server-adapters.test.mjs`
 * pins the list. #86's containment boundary is still `lib/content-root.mjs`'s, and any future app
 * module that needs it adds the name here deliberately.
 */
export { resolveContentRoot } from "../../lib/content-root.mjs";
