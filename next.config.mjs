/**
 * The application shell's Next.js configuration — TSK-0003, and deliberately almost empty.
 *
 * ⚠️ NO MDX INTEGRATION HERE, and its absence is a design decision rather than an omission.
 * `@next/mdx` routes `.mdx` files as pages, which AST-0030 measured compiling the document INTO
 * the build: an edit to a stage document then changes nothing a running server serves, which
 * REQ-0018 forbids. DEC-0020 chose request-time compilation with `@mdx-js/mdx` instead, so the
 * bundler integration, its remark-plugin path and Turbopack's config-serialisation constraint all
 * belong to the rejected alternative and none of them appears in this file. That configuration was
 * in TSK-0003 once, carried over from the probe that MEASURED the losing option.
 *
 * ⚠️ THE ROUTES LIVE AT `app/`, BESIDE THE SKELETON, and that was measured rather than chosen.
 * `src/app/` was tried first, to keep the shell clear of `app/server.mjs` — the walking skeleton
 * DEC-0017 keeps as the verified substrate reference. Next.js ignored it: a root `app/` directory
 * takes precedence over `src/app/`, so the build found no routes and emitted only `/404` from the
 * Pages Router. With the routes at `app/`, the skeleton is a colocated non-route file the App
 * Router leaves alone — `server.mjs` is neither a `page`, `layout` nor `route`, and `.mjs` is not
 * in the default `pageExtensions`.
 *
 * ⚠️ It also means DEC-0021's adapter path is honoured literally: `app/server/` is available as
 * the guarded door, sitting beside the file `app/server.mjs`. Similar names, unrelated things —
 * worth a second's care when reading a diff.
 */
export default {};
