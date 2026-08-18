/**
 * #83 — ID allocation.
 *
 * Three parts, because a reused ID is a data-integrity failure rather than an inconvenience:
 * every existing trace reference to the old artifact silently re-points at a different one.
 *
 *   (a) Tools never physically delete an artifact; removal is `lifecycle: retired`.
 *   (b) A durable per-prefix HIGH-WATER MARK is the authority on the next ID — never max()
 *       over the files that happen to exist, which reuses an ID the moment one is deleted.
 *   (c) Allocation is serialized through #78's lock, since #65 launches specialists in
 *       parallel and two children racing a counter is the normal case, not the edge.
 *
 * The order inside the lock is part of the decision:
 *
 *   lock -> read counter -> increment -> ATOMICALLY PERSIST counter -> write artifact -> unlock
 *
 * Persisting after the artifact means a crash in between leaves the counter behind the tree
 * and the next allocation reuses a live ID. Persisting first means a crash loses a number.
 * GAPS ARE A PROPERTY OF THE SAFETY MODEL, NOT A DEFECT — anything that "tidies" them
 * reintroduces the failure this exists to prevent. There is deliberately no rollback.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";

export const COUNTER_FILE = ".ids.json";
export const ID_DIGITS = 4;

export class AllocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AllocationError";
  }
}

export function counterPath(contentRoot) {
  return join(contentRoot, COUNTER_FILE);
}

/** Read the high-water marks. Missing file means nothing has ever been allocated. */
export function readHighWaterMarks(contentRoot) {
  const p = counterPath(contentRoot);
  if (!existsSync(p)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    throw new AllocationError(
      `Corrupt ID counter at ${p}: ${e.message}. Refusing to allocate — guessing here reuses IDs (#83).`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AllocationError(`Corrupt ID counter at ${p}: expected an object of prefix -> integer.`);
  for (const [k, v] of Object.entries(parsed))
    if (!Number.isInteger(v) || v < 0)
      throw new AllocationError(`Corrupt ID counter at ${p}: ${k} is ${JSON.stringify(v)}, expected a non-negative integer.`);
  return parsed;
}

export function formatId(prefix, n) {
  return `${prefix}-${String(n).padStart(ID_DIGITS, "0")}`;
}

/**
 * Allocate the next ID for `prefix` and PERSIST the counter before returning.
 *
 * MUST be called inside the content-root lock (#78) — it does not take the lock itself,
 * because the caller holds it across allocation AND the artifact write, which is what makes
 * the ordering above meaningful.
 *
 * @param {string} contentRoot
 * @param {string} prefix e.g. "REQ"
 * @returns {Promise<string>} the allocated ID
 */
export async function allocateId(contentRoot, prefix) {
  if (!/^[A-Z]{3}$/.test(prefix)) throw new AllocationError(`Bad prefix: ${JSON.stringify(prefix)}`);
  const marks = readHighWaterMarks(contentRoot);
  const next = (marks[prefix] ?? 0) + 1;
  const updated = {};
  for (const k of Object.keys({ ...marks, [prefix]: next }).sort()) updated[k] = k === prefix ? next : marks[k];
  await atomicWrite(counterPath(contentRoot), JSON.stringify(updated, null, 2) + "\n");
  return formatId(prefix, next);
}
