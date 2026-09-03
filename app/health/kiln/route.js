import { healthIdentity } from "../../server/identity.js";

/**
 * `/health/kiln` — the run-identity readiness endpoint (CMP-0038, REQ-0028).
 *
 * ⚠️ **`force-dynamic` IS AN EXPLICIT INVARIANT, NOT A FIX FOR A DEFECT IN THE PINNED VERSION.** It
 * guarantees this route renders per request, so the identity it reports is read from the running
 * process's environment. On the Next version pinned here a `GET` handler is already uncached by
 * default, so removing this line would not currently freeze anything — an earlier version of this
 * comment claimed it would, which overstated what the line does. It stays because the property it
 * names is the one thing this endpoint exists for, and a default is a weaker thing to depend on
 * than a declaration. What actually PROVES the property is the smoke check: the application is
 * built with one identity in the environment and started with a different one, and the response
 * must carry the identity it was STARTED with.
 *
 * ⚠️ **THE BODY IS DECIDED IN `lib/run-identity.mjs`**, and this file only transports it. Keeping
 * the shape out of the route is what lets the exact key set and every value be asserted without a
 * server; a route that assembled its own body would need one, and the checks would be the sort that
 * only run when someone remembers.
 *
 * ⚠️ **`no-store`, because a cached readiness answer is a lookalike with a longer reach.** A proxy
 * or a browser replaying a previous run's identity would say exactly what the supervisor wants to
 * hear, from a process that is no longer there.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const { status, body } = healthIdentity(process.env);
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
