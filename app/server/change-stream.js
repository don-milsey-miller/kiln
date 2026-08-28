import "server-only";

/**
 * The change-stream service, as the application sees it.
 *
 * ⚠️ NOT A CONTENT ADAPTER. `content.js` and `stages.js` exist so planning-content reads go through
 * the reader under `connection()`; this one hands out a notification service that reads nothing. The
 * boundary check knows the difference: each adapter declares who may import it, and this one admits
 * the events route rather than the reader. That declaration lives in `shellBoundaryConfig`, where a
 * reviewer reads it.
 *
 * ⚠️ Explicit named exports, never `export *` (DEC-0021).
 */
export { createChangeStream, EVENTS } from "../../lib/change-stream.mjs";
