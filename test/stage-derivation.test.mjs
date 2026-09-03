/**
 * ACC-0013 — the displayed current stage follows the attestations on disk, and nothing stores it.
 *
 * ⚠️ THE PRODUCTION HALF IS NOT HERE. Whether a RUNNING build reflects an attestation change without
 * a rebuild or restart was measured against `next build` + `next start` and recorded as evidence:
 * `data-vpw-current="none"` became `data-vpw-current="04-requirement-gaps"` three seconds after the
 * file changed, and returned when it was reverted. Repeating that in the suite would mean a second
 * production build on every run for a property the smoke check already forces to be live — `/` is
 * `ƒ`, and a route that had been frozen into the build would fail the smoke check's panel markers
 * the moment the content moved.
 *
 * ⚠️ WHAT IS HERE IS THE HALF A TEST CAN HOLD PERMANENTLY: that the derivation is a derivation, and
 * that no field anywhere under the content root stores the answer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStageDefinitions } from "../lib/stages.mjs";
import { loadStageAttestations } from "../lib/attestations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(ROOT, "planning-content");

/** The same rule the panel applies: the first stage whose gate is not ready. */
const deriveCurrent = (defs, attestationsFor) => {
  for (const def of Object.values(defs)) {
    const at = attestationsFor(def.id) ?? {};
    const criteria = def.exitCriteria ?? [];
    const ready = criteria.length > 0 && criteria.every((c) => ["satisfied", "n/a"].includes(at[c.id]?.result));
    if (!ready) return def.id;
  }
  return null;
};

test("the current stage moves when an attestation moves, and only then", () => {
  const defs = loadStageDefinitions(ROOT);
  const real = (id) => loadStageAttestations(CONTENT, id);

  // Today's real state, edited when the plan legitimately moves. Three criteria are deliberately
  // not satisfied and stage 4 is the earliest of them: `every-blocking-gap-decided`, because
  // QST-0033's OAuth question blocks active REQ-0025 and is undecided. Stage 5's data model and
  // stage 9's critical-question criterion are the other two.
  assert.equal(deriveCurrent(defs, real), "04-requirement-gaps", "the live project's first unready gate");

  // ⚠️ THE MUTATION HAS TO MOVE THE ANSWER, and this is the second time that needed attention. The
  // previous version flipped stage 4's own criterion and expected stage 4 — which was a real test
  // while stage 4 was green, and became vacuous the moment stage 4 went red for real: it asserted
  // an answer the base state already gave. A mutation test whose mutation changes nothing passes
  // forever. Stage 3 is chosen because it is currently READY and sits before stage 4.
  const withGap = (id) => {
    const at = { ...(real(id) ?? {}) };
    if (id === "03-discovery")
      at["unknowns-resolved"] = { result: "not-satisfied", decidedBy: "test", reason: "in-memory only" };
    return at;
  };
  assert.notEqual(deriveCurrent(defs, real), "03-discovery", "stage 3 must be ready, or the mutation below proves nothing");
  assert.equal(deriveCurrent(defs, withGap), "03-discovery");

  // ...and an EARLIER stage wins, because "current" is the first unready one rather than any of them.
  const withEarlier = (id) => {
    const at = { ...(withGap(id) ?? {}) };
    if (id === "02-intent-decomposition")
      at["scope-boundary-drawn"] = { result: "not-satisfied", decidedBy: "test", reason: "in-memory only" };
    return at;
  };
  assert.equal(deriveCurrent(defs, withEarlier), "02-intent-decomposition");
});

test("⚠️ no field under the content root stores a stage or project status", () => {
  // #16: stage position is derived from artifacts, never persisted beside them. A stored copy is the
  // one that goes stale silently, which is the whole reason the panel recomputes on every request.
  const FORBIDDEN = /"(currentStage|current_stage|stageStatus|stage_status|projectStage|project_status|projectStatus)"\s*:/;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
    );

  const offenders = walk(CONTENT)
    .filter((f) => /\.(json|ya?ml)$/.test(f) && statSync(f).isFile())
    .filter((f) => FORBIDDEN.test(readFileSync(f, "utf-8")));

  assert.deepEqual(offenders, [], "a stored stage position would be a derived value that can lie");
});
