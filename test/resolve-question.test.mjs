/**
 * `resolveQuestion` — the typed path for settling a question (#124's audit lesson applied:
 * a state transition the workflow authorises must have an operation).
 *
 * Constructed fixtures throughout, per #117: every branch here is a guard, and guards must be
 * proved on inputs built to hit them rather than on whatever live content happens to contain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createQuestion, createDecision, resolveQuestion } from "../lib/tools/evidence-tools.mjs";
import { ValidationError, createValidators } from "../lib/validate.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { artifactRelPath } from "../lib/layout.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);

function fresh() {
  const base = mkdtempSync(join(tmpdir(), "vpw-rq-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  return { base, contentRoot, o: { contentRoot, schemasDir: SCHEMAS, validators, schemas } };
}
const read = (contentRoot, type, id) => JSON.parse(readFileSync(join(contentRoot, artifactRelPath(type, id)), "utf-8"));

const QUESTION = { title: "Q", statement: "Does the thing hold?" };
const DECISION = { title: "D", statement: "It holds.", rationale: "Because measured.", decidedAt: "2026-08-22" };

test("answers a question and records what settled it", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const q = await createQuestion(QUESTION, o);
    const d = await createDecision(DECISION, o);
    const res = await resolveQuestion(q.id, "answered", { ...o, answer: "Yes.", answeredBy: [d.id] });

    assert.equal(res.from, "unanswered");
    assert.equal(res.to, "answered");
    const stored = read(contentRoot, "question", q.id);
    assert.equal(stored.resolution, "answered");
    assert.equal(stored.answer, "Yes.");
    assert.deepEqual(stored.answeredBy, [d.id]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("refuses `answered` with neither an answer nor a link", async () => {
  const { base, o } = fresh();
  try {
    const q = await createQuestion(QUESTION, o);
    await assert.rejects(() => resolveQuestion(q.id, "answered", o), (e) => {
      assert.ok(e instanceof ValidationError);
      assert.match(e.message, /records neither/);
      return true;
    });
    // ...and `deferred` does NOT require one, because deferring records no answer by definition.
    const res = await resolveQuestion(q.id, "deferred", o);
    assert.equal(res.to, "deferred");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("refuses a dangling `answeredBy`, and writes nothing when it does", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const q = await createQuestion(QUESTION, o);
    await assert.rejects(() => resolveQuestion(q.id, "answered", { ...o, answeredBy: ["DEC-9999"] }), ValidationError);
    const stored = read(contentRoot, "question", q.id);
    assert.equal(stored.resolution, "unanswered", "a refused resolution must leave the question untouched");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("refuses a non-ID and refuses reopening, each with a reason", async () => {
  const { base, o } = fresh();
  try {
    const q = await createQuestion(QUESTION, o);
    await assert.rejects(() => resolveQuestion(q.id, "answered", { ...o, answeredBy: ["not-an-id"] }), /not an artifact ID/);
    await assert.rejects(() => resolveQuestion(q.id, "unanswered", o), /Reopening is not implemented/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("settling an approved question marks it amended (#16)", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const q = await createQuestion(QUESTION, o);
    // Constructed state: approval is not something the create path can produce.
    const path = join(contentRoot, artifactRelPath("question", q.id));
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify({ ...doc, reviewStatus: "approved" }, null, 2) + "\n");

    await resolveQuestion(q.id, "answered", { ...o, answer: "Yes." });
    assert.equal(read(contentRoot, "question", q.id).reviewStatus, "amended");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("merges rather than replaces existing answeredBy links", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const q = await createQuestion(QUESTION, o);
    const d1 = await createDecision(DECISION, o);
    const d2 = await createDecision(DECISION, o);
    await resolveQuestion(q.id, "answered", { ...o, answeredBy: [d1.id] });
    await resolveQuestion(q.id, "answered", { ...o, answeredBy: [d2.id] });
    assert.deepEqual(read(contentRoot, "question", q.id).answeredBy, [d1.id, d2.id].sort());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
