import "server-only";

/**
 * Read-only access to the planning content root and its linted contents.
 *
 * ⚠️ Explicit named re-exports, never `export *` (DEC-0021). The surface here is what the first
 * slice needs and nothing else: `lintProject` returns records and findings, and the context
 * builders are what it needs to run. Adding a name to this file is a reviewable act; widening it
 * by wildcard would not be.
 *
 * ⚠️ Everything below is a READ. Nothing here takes the content lock or writes.
 *
 * ⚠️ THE PATH RESOLVERS MOVED TO `paths.js`, and the move is the reason this file still admits the
 * reader alone. `/events` needs to know where content lives so its watcher and the reader cannot
 * disagree; letting it through THIS door to get that would also have handed it `lintProject`. A
 * module that answers "where" without reading anything can have two consumers; this one cannot.
 */
export { loadSchemaSet } from "../../lib/schema-resolver.mjs";
export { createValidators } from "../../lib/validate.mjs";
export { readActivatedTypes } from "../../lib/activation.mjs";
export { lintProject, SEVERITY } from "../../lib/lint.mjs";
