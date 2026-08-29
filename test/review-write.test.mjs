/**
 * The review-status write — TSK-0012, CMP-0018, and the static half of ACC-0034.
 *
 * ⚠️ THE REAL LOCKING WRITE IS INJECTED, NOT A FAKE. `applyReviewSubmission` takes the write as an
 * argument, so these tests hand it the actual `setReviewStatus` from `lib/tools/` over a temporary
 * content root. A stubbed write would prove the branching and nothing about the thing that made
 * DEC-0021 hold this capability back for individual review: what happens when two of them land at
 * once. That is measured here, against the real lock, on a real directory.
 *
 * ⚠️ EVERY ASSERTION IS AGAINST THE DISK, NEVER AGAINST THE RETURN VALUE. A write path that reported
 * success while writing nothing would satisfy any check of what it returned — which is the same
 * shape as the build that succeeded while rendering nothing (`test/shell-smoke.test.mjs`) and the
 * total that counted files instead of artifacts (AST-0035). The return value is checked too, but
 * only after the file has been.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { setReviewStatus } from "../lib/tools/review-status.mjs";
import { loadSchemaSet, typeOfId } from "../lib/schema-resolver.mjs";
import { artifactRelPath } from "../lib/layout.mjs";
import { applyReviewSubmission, returnUrl, REVIEW, REVIEW_MESSAGE } from "../app/_write/review-logic.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const STATUSES = schemas.common.$defs.reviewStatus.enum;

const made = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** Two artifacts, so "only that one changed" is a question the fixture can actually answer. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "vpw-rw-"));
  made.push(base);
  const contentRoot = join(base, "planning-content");

  const put = (type, id, extra) => {
    const rel = artifactRelPath(type, id);
    const abs = join(contentRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      JSON.stringify(
        { id, type, schemaVersion: 2, reviewStatus: "draft", lifecycle: "active", title: id, ...extra },
        null,
        2
      ) + "\n"
    );
    return abs;
  };

  const target = put("requirement", "REQ-9001", { statement: "The thing must work.", priority: "must" });
  const bystander = put("requirement", "REQ-9002", { statement: "The other thing must work.", priority: "should" });
  return { base, contentRoot, target, bystander };
}

const deps = (contentRoot) => ({
  setReviewStatus,
  typeOf: (id) => typeOfId(schemas, id),
  statuses: STATUSES,
  contentRoot,
  schemasDir: SCHEMAS,
});

const read = (p) => JSON.parse(readFileSync(p, "utf-8"));

/** Every file under a root, by content hash — the only way to say "byte-identical" and mean it. */
function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

const changedFiles = (before, after) => {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
};

/* ------------------------------------------------------------------ the successful write */

test("⚠️ a successful submission changes reviewStatus ON DISK, and changes nothing else anywhere", async () => {
  const f = fixture();
  const before = snapshot(f.contentRoot);
  const wasBystander = readFileSync(f.bystander, "utf-8");

  const r = await applyReviewSubmission(
    { id: "REQ-9001", status: "in-review", path: "/stage/01-intake" },
    deps(f.contentRoot)
  );

  // ---- the disk first.
  const doc = read(f.target);
  assert.equal(doc.reviewStatus, "in-review", "the status must actually have been written");
  assert.equal(doc.lifecycle, "active", "lifecycle must be untouched — #82's two-axis split (ACC-0034)");
  assert.equal(doc.statement, "The thing must work.", "and nothing else about the artifact moved");
  assert.equal(doc.id, "REQ-9001");
  assert.equal(doc.title, "REQ-9001");

  assert.equal(readFileSync(f.bystander, "utf-8"), wasBystander, "the other artifact must be byte-identical");
  assert.deepEqual(
    changedFiles(before, snapshot(f.contentRoot)).filter((n) => !n.includes(".lock")),
    [relative(f.contentRoot, f.target)],
    "exactly one file may differ"
  );

  // ---- and only then what it said.
  assert.equal(r.code, REVIEW.OK);
  assert.equal(r.changed, true);
  assert.equal(r.redirectTo, "/stage/01-intake?artifact=REQ-9001", "back to the same page, selection intact");
});

test("submitting the status it already has is a no-op that still reports success", async () => {
  const f = fixture();
  const before = readFileSync(f.target, "utf-8");
  const r = await applyReviewSubmission({ id: "REQ-9001", status: "draft", path: "/stage/01-intake" }, deps(f.contentRoot));
  assert.equal(r.code, REVIEW.OK);
  assert.equal(r.changed, false, "the typed write reports it did nothing");
  assert.equal(readFileSync(f.target, "utf-8"), before, "and the file is untouched, not rewritten identically");
});

/* ------------------------------------------------------------------ every refusal */

test("⚠️ an invalid status is refused and NOTHING is written", async () => {
  const f = fixture();
  const before = snapshot(f.contentRoot);

  for (const bad of ["approve", "APPROVED", "retired", "", "draft; rm -rf /", "lifecycle"]) {
    const r = await applyReviewSubmission({ id: "REQ-9001", status: bad, path: "/stage/01-intake" }, deps(f.contentRoot));
    assert.equal(r.code, REVIEW.BAD_STATUS, `${JSON.stringify(bad)} must be refused`);
  }
  // ⚠️ `retired` and `lifecycle` are in that list deliberately: they are the words someone would try
  // if they were reaching for the other axis. There is no argument this path could pass that would
  // reach `lifecycle`, and this is the check that says so.
  assert.deepEqual(changedFiles(before, snapshot(f.contentRoot)).filter((n) => !n.includes(".lock")), []);
});

test("⚠️ an unknown artifact is refused as unknown, not as a generic failure", async () => {
  const f = fixture();
  const before = snapshot(f.contentRoot);

  const r = await applyReviewSubmission({ id: "REQ-9999", status: "in-review", path: "/stage/01-intake" }, deps(f.contentRoot));
  assert.equal(r.code, REVIEW.UNKNOWN_ARTIFACT);
  assert.match(r.redirectTo, /reviewError=unknown-artifact/);
  assert.deepEqual(changedFiles(before, snapshot(f.contentRoot)).filter((n) => !n.includes(".lock")), []);
});

test("⚠️ the wording that distinguishes 'unknown' from 'failed' is PINNED to the real tool", async () => {
  // `typeOfId` answers from the id's shape, so a missing artifact is only discovered inside the
  // lock, and the sole thing separating it from any other write failure is this message. If the tool
  // rewords it, every missing artifact silently becomes "the write did not complete" — a real
  // degradation that no other test would notice. So the coupling is asserted rather than assumed.
  const f = fixture();
  await assert.rejects(
    () => setReviewStatus("requirement", "REQ-9999", "in-review", { contentRoot: f.contentRoot, schemasDir: SCHEMAS }),
    (e) => {
      assert.ok(
        String(e.message).startsWith("No such "),
        `review-logic.js branches on this prefix; got: ${e.message}`
      );
      return true;
    }
  );
});

test("an id that is not an artifact id at all is refused before anything is resolved", async () => {
  const f = fixture();
  for (const bad of ["", "REQ", "req-9001", "../../etc/passwd", "REQ-9001.json", "ZZZ-0001"]) {
    const r = await applyReviewSubmission({ id: bad, status: "in-review", path: "/stage/01-intake" }, deps(f.contentRoot));
    assert.ok(
      r.code === REVIEW.NO_ID || r.code === REVIEW.UNKNOWN_ARTIFACT,
      `${JSON.stringify(bad)} must be refused, got ${r.code}`
    );
  }
});

test("⚠️ approving with nobody attached is refused, and no approval reaches the disk", async () => {
  const f = fixture();
  const r = await applyReviewSubmission({ id: "REQ-9001", status: "approved", path: "/stage/01-intake" }, deps(f.contentRoot));
  assert.equal(r.code, REVIEW.NEEDS_REVIEWER);
  assert.equal(read(f.target).reviewStatus, "draft", "an unattributable approval must not be recorded");

  const ok = await applyReviewSubmission(
    { id: "REQ-9001", status: "approved", reviewedBy: "the PM", path: "/stage/01-intake" },
    deps(f.contentRoot)
  );
  assert.equal(ok.code, REVIEW.OK);
  assert.equal(read(f.target).reviewStatus, "approved");
});

test("every refusal code has a message, and the codes and messages do not drift apart", () => {
  // A code with no message renders an empty error box: a failure the operator cannot see, which is
  // the one thing this path must never do.
  for (const [name, code] of Object.entries(REVIEW)) {
    if (code === REVIEW.OK) continue;
    assert.ok(REVIEW_MESSAGE[code], `${name} (${code}) has no message`);
    assert.ok(REVIEW_MESSAGE[code].length > 20, `${name}'s message is too short to explain anything`);
  }
});

/* ------------------------------------------------------------------ concurrency: the reason for the review */

test("⚠️ CONCURRENT conflicting writes leave ONE valid artifact, never half of two", async () => {
  // This is what DEC-0021 held the capability back to examine. A Server Component can be rendering
  // several requests at once; the CLI this write was built for never could. The lock and the atomic
  // write are what make it safe, and this is the test that they are actually on the path — a plain
  // `writeFileSync` would pass every other test in this file.
  const f = fixture();
  const order = ["in-review", "amended", "draft", "in-review", "amended", "draft", "in-review", "amended"];

  const results = await Promise.all(
    order.map((status) => applyReviewSubmission({ id: "REQ-9001", status, path: "/stage/01-intake" }, deps(f.contentRoot)))
  );

  for (const r of results) assert.equal(r.code, REVIEW.OK, `a concurrent submission failed: ${r.code}`);

  const raw = readFileSync(f.target, "utf-8");
  const doc = JSON.parse(raw); // throws on a torn write, which is the point
  assert.ok(order.includes(doc.reviewStatus), `final status ${doc.reviewStatus} is not one that was submitted`);
  assert.equal(doc.lifecycle, "active");
  assert.equal(doc.statement, "The thing must work.", "no field was lost in the interleaving");
  assert.equal(raw.endsWith("\n"), true, "a complete file, not a truncated one");

  // ⚠️ AND THE ONE ASSERTION THAT ACTUALLY SEES THE LOCK. Everything above is a SAFETY property, and
  // safety is the weaker claim: an unlocked read-modify-write was measured passing every line of it,
  // because small `writeFileSync` calls do not visibly tear and no writer drops a field.
  //
  // Serialisation shows up in `changed` instead. Under the lock each submission reads what the
  // previous one wrote, so a run whose statuses never repeat consecutively changes on every one of
  // them: 8 of 8. Without the lock the submissions all read `draft` through the same window, and the
  // three that ask for `draft` report no change: 6 of 8, measured, and stable across five runs of
  // both. If this ever reads 6 the lock has left the path, whatever the other assertions say.
  assert.equal(
    results.filter((r) => r.changed).length,
    order.length,
    "a submission saw a stale value — the write is no longer serialised by the content lock"
  );
});

test("concurrent writes to DIFFERENT artifacts both land", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    applyReviewSubmission({ id: "REQ-9001", status: "in-review", path: "/stage/01-intake" }, deps(f.contentRoot)),
    applyReviewSubmission({ id: "REQ-9002", status: "amended", path: "/stage/01-intake" }, deps(f.contentRoot)),
  ]);
  assert.equal(a.code, REVIEW.OK);
  assert.equal(b.code, REVIEW.OK);
  assert.equal(read(f.target).reviewStatus, "in-review");
  assert.equal(read(f.bystander).reviewStatus, "amended", "the lock must serialise, not drop one");
});

/* ------------------------------------------------------------------ the redirect target */

test("⚠️ the return path is MATCHED against a shape, never sanitised", () => {
  assert.equal(returnUrl({ path: "/stage/01-intake", artifactId: "REQ-0001" }), "/stage/01-intake?artifact=REQ-0001");
  assert.equal(returnUrl({ path: "/stage/01-intake", artifactId: "REQ-0001", error: REVIEW.BAD_STATUS }),
    "/stage/01-intake?artifact=REQ-0001&reviewError=bad-status");

  // Anything that is not exactly a stage path falls back to a real page. Sanitising means removing
  // what is dangerous and hoping the list was complete; matching means none of these can be a target.
  for (const hostile of [
    "//evil.example/x",
    "https://evil.example",
    "javascript:alert(1)",
    "/stage/../../etc/passwd",
    "/stage/a/b",
    "/stage/01-intake?x=1",
    "/events",
    "",
    null,
  ])
    assert.equal(returnUrl({ path: hostile, artifactId: "REQ-0001" }), "/?artifact=REQ-0001", `accepted ${JSON.stringify(hostile)}`);

  assert.equal(returnUrl({ path: "/stage/01-intake", artifactId: "not-an-id" }), "/stage/01-intake");
});

/* ------------------------------------------------------------------ the adapter's surface */

test("⚠️ the review adapter exposes EXACTLY ONE write, and no other locking operation", () => {
  // ⚠️ This is the check the falsification targets. Every other locking operation in `lib/tools/` —
  // `setLifecycle`, `reviseArtifact`, `createArtifact`, `linkTrace` — is a one-line addition to that
  // adapter, and each would be invisible in review as anything but a line that looks like its
  // neighbours. Adding one makes this fail by name.
  const src = readFileSync(join(ROOT, "app", "server", "review.js"), "utf-8");
  const exported = [...src.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].flatMap(([, names, from]) =>
    names.split(",").map((n) => ({ name: n.trim().split(/\s+as\s+/).pop().trim(), from }))
  );

  assert.ok(!/export\s*\*/.test(src), "a wildcard re-export would make this surface unreviewable (DEC-0021)");
  assert.match(src, /^import "server-only";/m, "a write adapter that could be imported from the browser is not an adapter");

  const WRITES = ["setReviewStatus", "setLifecycle", "reviseArtifact", "createArtifact", "createRequirement",
    "linkTrace", "unlinkTrace", "linkEvidence", "unlinkEvidence", "resolveQuestion", "setTypeActivation",
    "createAssertion", "createEvidence", "createDecision", "createTask", "createComponent",
    "createAcceptanceCriterion", "createQuestion", "createRunbookStep", "atomicWrite", "withLock"];

  assert.deepEqual(
    exported.map((e) => e.name).filter((n) => WRITES.includes(n)),
    ["setReviewStatus"],
    "the application may perform exactly one kind of write"
  );
  assert.deepEqual(exported.map((e) => e.name).sort(), ["loadSchemaSet", "setReviewStatus", "typeOfId"]);
});

test("⚠️ no OTHER adapter exposes a write either", () => {
  // The restriction is about the application's whole surface, not one file. A second write door
  // opened next to this one would leave the check above perfectly green.
  const dir = join(ROOT, "app", "server");
  const WRITE_MODULES = /lib\/tools\/|lib\/lock\.mjs|lib\/atomic-write\.mjs/;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(join(dir, name), "utf-8");
    for (const [, , from] of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g))
      if (WRITE_MODULES.test(from))
        assert.equal(name, "review.js", `${name} re-exports from ${from} — writes live in review.js alone`);
  }
});
