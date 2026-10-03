import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactReviewChoices, artifactReviewSearch } from "../app/_review/artifact-review-choices.js";

const record = (doc, overrides = {}) => ({
  doc,
  filenameId: doc?.id ?? null,
  dirType: doc?.type ?? null,
  ...overrides,
});

test("an empty project has no invented review choice", () => {
  assert.deepEqual(artifactReviewChoices([], []), []);
  assert.deepEqual(artifactReviewChoices([{ doc: null }], ["requirement"]), []);
});

test("only active, non-retired artifacts are offered for review", () => {
  const choices = artifactReviewChoices(
    [
      record({ id: "DEC-0002", type: "decision", title: "Inactive", reviewStatus: "draft", lifecycle: "active" }),
      record({ id: "REQ-0002", type: "requirement", title: "Retired", reviewStatus: "approved", lifecycle: "retired" }),
      record({ id: "REQ-0001", type: "requirement", title: "Current", reviewStatus: "in-review", lifecycle: "active" }),
    ],
    ["requirement"]
  );

  assert.deepEqual(choices, [
    { id: "REQ-0001", type: "requirement", title: "Current", reviewStatus: "in-review" },
  ]);
});

test("malformed identities and lifecycles never become unusable review choices", () => {
  const choices = artifactReviewChoices(
    [
      record({ type: "requirement", title: "Missing id", lifecycle: "active" }),
      record(
        { id: "REQ-0001", type: "requirement", title: "Wrong filename", lifecycle: "active" },
        { filenameId: "REQ-9999" }
      ),
      record(
        { id: "REQ-0002", type: "requirement", title: "Wrong directory", lifecycle: "active" },
        { dirType: "decision" }
      ),
      record({ id: "REQ-0003", type: "requirement", title: "Missing lifecycle" }),
      record({ id: "REQ-0004", type: "requirement", title: "Invalid lifecycle", lifecycle: "archived" }),
      record({ id: "REQ-0005", type: "requirement", title: "Usable", lifecycle: "active" }),
    ],
    ["requirement"]
  );

  assert.deepEqual(choices, [
    { id: "REQ-0005", type: "requirement", title: "Usable", reviewStatus: "draft" },
  ]);
});

test("choices are stable by type then id and fill safe display defaults", () => {
  const choices = artifactReviewChoices(
    [
      record({ id: "REQ-0002", type: "requirement", lifecycle: "active" }),
      record({ id: "CMP-0001", type: "component", title: "Shell", lifecycle: "active" }),
      record({ id: "REQ-0001", type: "requirement", title: "First", reviewStatus: "approved", lifecycle: "active" }),
    ],
    ["requirement", "component"]
  );

  assert.deepEqual(choices.map((choice) => choice.id), ["CMP-0001", "REQ-0001", "REQ-0002"]);
  assert.deepEqual(choices[2], { id: "REQ-0002", type: "requirement", title: "", reviewStatus: "draft" });
});

test("review search filters by id, title, type and status while bounding rendered choices", () => {
  const records = Array.from({ length: 80 }, (_, i) =>
    record({
      id: `REQ-${String(i + 1).padStart(4, "0")}`,
      type: "requirement",
      title: i === 41 ? "Accessible volunteer onboarding" : `Requirement ${i + 1}`,
      reviewStatus: i % 2 === 0 ? "draft" : "approved",
      lifecycle: "active",
    })
  );
  records.push(record({ id: "DEC-0001", type: "decision", title: "Volunteer access", reviewStatus: "approved", lifecycle: "active" }));

  const bounded = artifactReviewSearch(records, ["requirement", "decision"]);
  assert.deepEqual([bounded.total, bounded.matched, bounded.items.length, bounded.truncated], [81, 81, 50, true]);

  const byTitle = artifactReviewSearch(records, ["requirement", "decision"], { query: "accessible volunteer" });
  assert.deepEqual(byTitle.items.map((item) => item.id), ["REQ-0042"]);

  const filtered = artifactReviewSearch(records, ["requirement", "decision"], { type: "decision", status: "approved" });
  assert.deepEqual(filtered.items.map((item) => item.id), ["DEC-0001"]);
});
