/**
 * `node:path`, reached in a way the production build cannot follow (#186).
 *
 * ⚠️ **EVERY MODULE UNDER `lib/` TAKES ITS PATH FUNCTIONS FROM HERE, NOT FROM `node:path`.** Turbopack evaluates
 * `path.join` and `path.resolve` while it bundles the browser shell. A call whose base it cannot evaluate and whose
 * tail is a literal, such as `join(contentRoot, "data", type)`, is turned into a pattern and matched against the whole
 * build root, and every match is written into the route's `.nft.json` trace. Measured on `d2ff706`: the ingest route
 * traced 1,218 files, among them the clone's `.git` and its `planning-content`, from nothing but joins like that one.
 *
 * The roots Kiln joins onto are chosen when a request runs: the content root, the project root, the tool root. None
 * is a build input. Taking the functions from `process.getBuiltinModule` leaves the bundler with calls it does not
 * recognise, so it derives no pattern from them. The functions are Node's own and behave identically.
 *
 * ⚠️ **A `turbopackIgnore` COMMENT ON THE FILESYSTEM CALL DOES NOT DO THIS.** Measured: with the comment on
 * `existsSync(...)` and the join inside it, the join's matches were still traced. Only a comment inside the join
 * itself stopped it, and there are several hundred joins.
 *
 * ⚠️ **THIS IS NOT A SECURITY BOUNDARY.** It decides what the build records. Containment at run time is still
 * `content-root.mjs`'s canonical check. `test/build-trace.test.mjs` reads the traces a real build produces and is the
 * evidence that this works; nothing here is.
 */
const path = process.getBuiltinModule("node:path");

export default path;
export const { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, posix, relative, resolve, sep, win32 } = path;
