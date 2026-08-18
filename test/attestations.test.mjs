import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadStageAttestations, stageAttestationsPath } from "../lib/attestations.mjs";

function fixture() {
  return mkdtempSync(join(tmpdir(), "planning-attestations-"));
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

test("missing stage-attestation state means no evaluations, not an invented pass", () => {
  const root = fixture();
  try {
    assert.deepEqual(loadStageAttestations(root, "01-intake"), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one stage reads only its own persisted evaluations", () => {
  const root = fixture();
  try {
    const attestations = { "ask-without-solution": { result: "satisfied", decidedBy: "pm" } };
    write(stageAttestationsPath(root, "01-intake"), { stageId: "01-intake", attestations });
    assert.deepEqual(loadStageAttestations(root, "01-intake"), attestations);
    assert.deepEqual(loadStageAttestations(root, "02-intent-decomposition"), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stage-id mismatch fails loudly instead of applying another stage's verdicts", () => {
  const root = fixture();
  try {
    write(stageAttestationsPath(root, "01-intake"), { stageId: "02-intent-decomposition", attestations: {} });
    assert.throws(() => loadStageAttestations(root, "01-intake"), /expected "01-intake"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed attestation state fails loudly", () => {
  const root = fixture();
  try {
    const path = stageAttestationsPath(root, "01-intake");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    assert.throws(() => loadStageAttestations(root, "01-intake"), /Cannot read stage attestations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
