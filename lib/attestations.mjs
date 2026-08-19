/**
 * Persistent human gate evaluations (#93).
 *
 * Attestations are lightweight planning state, not planning artifacts. One file per stage
 * keeps the write unit aligned with #87 and avoids turning every gate evaluation into a
 * shared-file edit:
 *
 *   planning-content/state/stage-attestations/<stage-id>.json
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STAGE_ATTESTATIONS_DIR = join("state", "stage-attestations");

export function stageAttestationsPath(contentRoot, stageId) {
  if (typeof stageId !== "string" || !/^[0-9]{2}-[a-z0-9-]+$/.test(stageId))
    throw new Error(`Invalid stage id for attestations: ${JSON.stringify(stageId)}`);
  return join(contentRoot, STAGE_ATTESTATIONS_DIR, `${stageId}.json`);
}

export function loadStageAttestations(contentRoot, stageId) {
  const path = stageAttestationsPath(contentRoot, stageId);
  if (!existsSync(path)) return {};

  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read stage attestations at ${path}: ${error.message}`);
  }

  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error(`Stage attestations at ${path} must be a JSON object.`);
  if (record.stageId !== stageId)
    throw new Error(`Stage attestations at ${path} declare ${JSON.stringify(record.stageId)}, expected ${JSON.stringify(stageId)}.`);
  if (!record.attestations || typeof record.attestations !== "object" || Array.isArray(record.attestations))
    throw new Error(`Stage attestations at ${path} must contain an attestations object.`);

  return record.attestations;
}

/**
 * Record one attestation (#93). Added 2026-08-18: this module could READ evaluations and not
 * write them, so the only way to attest was hand-editing JSON — the same gap `setLifecycle`
 * closed for lifecycle (#114). Attestations are planning state rather than artifacts, but they
 * gate stage transitions, so they get the same write discipline: lock (#78), fresh read inside
 * it, atomic write (#72).
 *
 * ⚠️ `result` is `satisfied` | `not-satisfied` | `n/a`. There is deliberately no
 * "acknowledged": seeing a criterion is not a verdict on it (#93).
 */
export async function writeStageAttestation(contentRoot, stageId, criterionId, { result, decidedBy, reason }) {
  const { withLock } = await import("./lock.mjs");
  const { atomicWrite } = await import("./atomic-write.mjs");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");

  const allowed = ["satisfied", "not-satisfied", "n/a"];
  if (!allowed.includes(result)) throw new Error(`result must be one of ${allowed.join(", ")}, got ${JSON.stringify(result)}.`);
  if (!decidedBy) throw new Error("An attestation must record who evaluated it (#93).");
  if (result === "n/a" && !(typeof reason === "string" && reason.trim()))
    throw new Error("An n/a attestation requires a reason (#45's shape).");

  const path = stageAttestationsPath(contentRoot, stageId);
  return withLock(join(contentRoot, ".planning.lock"), async () => {
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { stageId, attestations: {} };
    existing.attestations[criterionId] = { result, decidedBy, ...(reason ? { reason } : {}) };
    mkdirSync(dirname(path), { recursive: true });
    await atomicWrite(path, JSON.stringify(existing, null, 2) + "\n");
    return existing.attestations[criterionId];
  });
}
