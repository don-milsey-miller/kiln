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
