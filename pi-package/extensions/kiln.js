/**
 * Kiln's registration entry point — TSK-0043, CMP-0031, against ACC-0063.
 *
 * Pi loads this file when the project is trusted and the package is registered in the project's
 * settings. Loading it is the observable: an untrusted project never reaches this line, which is the
 * control ACC-0063 asks for.
 *
 * ⚠️ **IT REGISTERS NO TOOLS YET, AND THAT IS THE TASK BOUNDARY.** The read, mutation and attestation
 * tools are TSK-0044's; the research, validation, delegation and capability tools are TSK-0045's. A
 * tool registered here ahead of them would be a tool with no criterion accepting it — which is
 * exactly the gap ACC-0109 was created to close for the capability tool.
 *
 * ⚠️ **IT DOES NOTHING ON IMPORT BEYOND DECLARING.** No project content is read, no file is written,
 * no credential is looked at and nothing is contacted. An extension runs inside the operator's
 * session with their environment; work at import time is work nobody asked for, and an entry point
 * that touched the project would make "the package loaded" indistinguishable from "the package did
 * something".
 *
 * ⚠️ **THE VERSION IS AUTHORED HERE AS WELL AS IN `signature.json`, ON PURPOSE.** Two independent
 * statements of the same number are how drift becomes visible: a declaration edited without its
 * entry point, or the reverse, fails a check rather than shipping as a signature nobody verified.
 */

import declaration from "../signature.json" with { type: "json" };

/**
 * The signature version this entry point was written against.
 *
 * ⚠️ Authored by hand rather than read from the declaration. Reading it from there would make the
 * two agree by construction and prove nothing.
 */
export const SIGNATURE_VERSION = 1;

/** Deeply frozen, so a consumer cannot edit the declaration it was handed and hand it on. */
const deepFreeze = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value !== null && typeof value === "object")
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepFreeze(v)])));
  return value;
};

/**
 * What this package declares it owns: the names, and nothing about what they do.
 *
 * ⚠️ `tools` IS EMPTY AND SAYS SO. An empty list is a claim — this package registers no tools yet —
 * where an absent field would be a consumer's guess.
 */
export const SIGNATURE = deepFreeze(declaration);

/**
 * Pi's registration hook.
 *
 * @param {object} _pi  Pi's extension API. Unused until tools are registered against it.
 */
export default function register(_pi) {
  // Deliberately empty: see the header. Registering a tool here belongs to TSK-0044 and TSK-0045.
}
