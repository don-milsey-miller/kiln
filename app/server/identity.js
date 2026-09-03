import "server-only";

/**
 * WHO answered — and nothing that reads planning content.
 *
 * ⚠️ **A THIRD DOOR, ADMITTING ONE CONSUMER, HOLDING ONE NAME.** The argument that let `paths.js`
 * admit two consumers was that it holds nothing but a path calculation, so it widens no read
 * surface. The same argument applies here and is why this is its own module rather than a name
 * added to an existing adapter: `healthIdentity` opens no content, takes no lock and caches
 * nothing — it reads two environment variables and the tool's own `package.json` version. Folding
 * it into `content.js` would have handed the health route the reader in order to give it a run ID.
 *
 * ⚠️ The route needs it because the readiness handshake is a claim about the RESPONDER, and only
 * the process answering can make that claim. See `lib/run-identity.mjs` for why every field is
 * there.
 */
export { healthIdentity } from "../../lib/run-identity.mjs";
