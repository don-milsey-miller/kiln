/**
 * Whether this process is a delegated specialist child - #219.
 *
 * The runtime starts every child with `KILN_TASK_NONCE` (`NONCE_ENV`), and nothing else sets it. Kiln's extension is
 * loaded in a child as well as in the operator's session, and reads no environment itself, so this is where it asks.
 *
 * ⚠️ **THE ANSWER ONLY EVER TAKES SOMETHING AWAY.** A child is refused what belongs to the operator's session: the
 * session's prompt augmentation here, and the vault, the carry-over and the bundle journal where those are read
 * (#215). A process that sets the marker on itself loses those and gains nothing, so forging it is not a privilege.
 */

import { NONCE_ENV } from "./task-observer.mjs";

/** @param {Record<string, string|undefined>} [env] */
export function isDelegatedChild(env = process.env) {
  const marker = env?.[NONCE_ENV];
  return typeof marker === "string" && marker.length > 0;
}
