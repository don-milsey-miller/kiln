/**
 * The run-identity health answer — CMP-0038, against ACC-0077.
 *
 * ⚠️ **IT ANSWERS WITH AN IDENTITY, NOT A STATUS.** REQ-0028's whole point is that a response which
 * merely arrives proves nothing: an unrelated service on port 3000, or a Kiln left over from a
 * previous run still holding the port, both answer an HTTP probe perfectly. Every field here exists
 * to defeat one specific lookalike — the run ID defeats the previous Kiln, the project ID defeats a
 * Kiln serving a different project, the service name and protocol defeat an application that merely
 * returns JSON.
 *
 * ⚠️ **THE IDENTIFIERS ARE VALIDATED BEFORE THEY ARE ECHOED, WHICH IS WHY THE RESPONSE CANNOT LEAK.**
 * This module reflects environment values into an HTTP body, so "contains no absolute path" cannot
 * rest on scanning the output for path-shaped text — a scan only catches the shapes somebody thought
 * of. Both identifiers must match `^[0-9a-f]{32}$`, so anything that is not thirty-two hex characters
 * is not echoed at all, whatever it is. That makes the guarantee structural: the response is built
 * from a fixed literal, a validated identifier, and a package version.
 *
 * ⚠️ **NO IDENTITY IS ITS OWN ANSWER, NOT A DEGRADED ONE.** Started by hand rather than by the
 * supervisor, this process has no run to name. It says so with 503 and a body of its own fixed
 * shape, because a 200 with the identity fields missing is exactly the "response that merely
 * arrives" the requirement refuses — and inventing a run ID would be worse still, since it would
 * make an unsupervised process indistinguishable from a supervised one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toolRoot } from "./content-root.mjs";

/** The service name. Fixed: it identifies the software, not the invocation. */
export const SERVICE = "kiln";

/**
 * ⚠️ **VERSIONED SO A FUTURE SHAPE CHANGE IS DETECTABLE RATHER THAN CONFUSING.** A supervisor from
 * a newer tool checkout polling an older server would otherwise read missing fields as a failed
 * handshake with no way to say why. Bumped when the response shape changes, never for content.
 */
export const HEALTH_PROTOCOL = "kiln.health/1";

/** The route this is served from, named here so the supervisor and the app cannot disagree. */
export const HEALTH_PATH = "/health/kiln";

/**
 * ⚠️ **NAMED CONSTANTS BECAUSE THREE PROCESSES HAVE TO AGREE.** The supervisor sets these, the
 * launcher forwards them, the route reads them. Three string literals in three files is three
 * chances for a typo that presents as a readiness timeout rather than as a mistake.
 */
export const RUN_ID_ENV = "KILN_RUN_ID";
export const PROJECT_ID_ENV = "KILN_PROJECT_ID";

/** Both identifiers are 32 lowercase hex characters — the shape `runtime-common.schema.json` fixes. */
const IDENTIFIER = /^[0-9a-f]{32}$/;

/**
 * A version this module is willing to put in a response.
 *
 * ⚠️ **THE BUILD FIELD NEEDED THE SAME TREATMENT AS THE IDENTIFIERS, AND DID NOT HAVE IT.** The
 * claim is that the WHOLE response cannot leak, and that only holds if every field is built from
 * something validated. This one comes from a file on disk — a `package.json` whose `version` is
 * whatever it is — so it is checked against a character set with no separator, colon or whitespace
 * in it: nothing shaped like a path can reach the body through this field either.
 */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export const NO_IDENTITY = "no-run-identity";
export const NO_BUILD = "no-build-identity";

/** ⚠️ Every failure answers with the SAME key set, so a caller parses one shape and reads `error`. */
const unavailable = (error) => ({ status: 503, body: { service: SERVICE, protocol: HEALTH_PROTOCOL, error } });

/**
 * The tool's own package version.
 *
 * ⚠️ **READ FROM THE BUILD, NOT FROM THE ENVIRONMENT, AND THE DIFFERENCE IS THE POINT.** A build
 * version the supervisor supplied would be the supervisor reading back its own input — it could
 * only ever match. Taken from the package the running code was loaded from, it is a fact about the
 * responder.
 *
 * ⚠️ **IT DISCRIMINATES NOTHING TODAY**, and saying so is more useful than implying otherwise: this
 * package is version `0.0.0` and every build reports it. The lookalike-defeating work is carried by
 * the run ID, which is per-invocation. The field is here so the handshake has somewhere to put a
 * real build identity when there is one.
 */
export function toolVersion(root = toolRoot()) {
  try {
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;
    return typeof version === "string" && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Build the health response: an exact status and an exact body.
 *
 * ⚠️ Returns the response rather than writing one, so the whole contract is testable without a
 * server — the route is four lines of translation on top of this.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{build?: string|null}} [opts]  `build` for tests; production reads the package
 * @returns {{status: number, body: object}}
 */
export function healthIdentity(env = process.env, opts = {}) {
  const runId = env?.[RUN_ID_ENV];
  const projectId = env?.[PROJECT_ID_ENV];

  // ⚠️ **`typeof` FIRST, BECAUSE `RegExp.test` COERCES.** `IDENTIFIER.test(["a1b2…"])` is TRUE —
  // a one-element array stringifies to its element — and the array, not the string, is what would
  // have been echoed into the JSON. Environment variables are always strings, but this function
  // takes any object, and "it can only be called with real env" is the kind of assumption that
  // stops being true silently.
  const identified =
    typeof runId === "string" && IDENTIFIER.test(runId) && typeof projectId === "string" && IDENTIFIER.test(projectId);
  if (!identified) return unavailable(NO_IDENTITY);

  // ⚠️ **RESOLVED AND VALIDATED BEFORE THE SUCCESS BRANCH, NOT INSIDE IT.** This used to emit a
  // complete five-field identity with `build: null` when the package could not be read — a 200
  // whose build field said nothing, which is the "response that merely arrives" wearing four
  // correct fields. An identity that is not whole is not an identity.
  const build = opts.build !== undefined ? opts.build : toolVersion();
  if (typeof build !== "string" || !VERSION.test(build)) return unavailable(NO_BUILD);

  return { status: 200, body: { service: SERVICE, protocol: HEALTH_PROTOCOL, runId, projectId, build } };
}
