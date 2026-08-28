/**
 * Totals against an independent oracle, and located parse failures — TSK-0016, ACC-0014, ACC-0015.
 *
 * ⚠️ THE ORACLE IS THE WHOLE POINT. ACC-0014 originally read "every rendered count equals the number
 * rendered on the page", and that was UNFALSIFIABLE: the view renders totals, not entries, so it
 * compared a number with itself and would have passed on an implementation that printed a constant.
 * The amended criterion tests against a fixture whose composition is known in advance and computed
 * outside the application — the only source of truth the application cannot influence.
 *
 * ⚠️ These run the reader's counting rule directly rather than through a browser. The production half
 * — corrupt a file while serving, watch the total fall and the error appear, restore it and watch
 * both recover — is in the smoke test, because it needs a running build.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArtifacts } from "../lib/lint.mjs";
import { reapLater, installReaper } from "./helpers/reap.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A content root whose composition is declared here, in the test, and never derived from the code
 * under examination.
 */
const COMPOSITION = { requirement: 3, assertion: 2, decision: 1 };
const DIR_FOR = { requirement: "requirements", assertion: "assertions", decision: "decisions" };
const PREFIX = { requirement: "REQ", assertion: "AST", decision: "DEC" };

function fixture({ corrupt = null } = {}) {
  const base = reapLater(mkdtempSync(join(tmpdir(), "vpw-diag-")));
  const content = join(base, "planning-content");
  for (const [type, n] of Object.entries(COMPOSITION)) {
    const dir = join(content, "data", DIR_FOR[type]);
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= n; i++) {
      const id = `${PREFIX[type]}-${String(i).padStart(4, "0")}`;
      const file = join(dir, `${id}.json`);
      const good = JSON.stringify({ id, type, schemaVersion: 2, reviewStatus: "draft", lifecycle: "active", title: id }, null, 2);
      writeFileSync(file, corrupt === id ? "{ this is not json" : good);
    }
  }
  return { base, content };
}

/** The counting rule the reader applies, isolated so the oracle compares against behaviour. */
const totalsFrom = (records) => {
  const counts = {};
  for (const r of records.filter((x) => x.doc)) counts[r.doc.type] = (counts[r.doc.type] ?? 0) + 1;
  return counts;
};

test("every total equals the fixture's parsable artifacts of that type", () => {
  const { base, content } = fixture();
  try {
    const records = loadArtifacts({ contentRoot: content });
    assert.deepEqual(totalsFrom(records), COMPOSITION, "the totals must match the composition declared above");
    assert.equal(records.filter((r) => r.doc).length, 6);
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("⚠️ one corrupt artifact costs exactly one from its own type, and nothing from any other", () => {
  const { base, content } = fixture({ corrupt: "REQ-0002" });
  try {
    const records = loadArtifacts({ contentRoot: content });
    assert.deepEqual(totalsFrom(records), { ...COMPOSITION, requirement: COMPOSITION.requirement - 1 });

    // ...and the file is still SEEN, so it can be reported rather than vanishing.
    const bad = records.filter((r) => !r.doc);
    assert.equal(bad.length, 1);
    assert.match(bad[0].relPath, /requirements\/REQ-0002\.json$/);
    assert.match(bad[0].parseError, /\(line \d+ column \d+\)/, "the parse error must carry a position");
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a file count would have given the wrong answer — which is why the rule is 'parsed'", () => {
  // The control for the counting rule. `records.length` counts FILES; the totals count documents.
  // The reader used records.length for its artifact total until this task, which is AST-0035's
  // defect waiting to happen in a second place.
  const { base, content } = fixture({ corrupt: "AST-0001" });
  try {
    const records = loadArtifacts({ contentRoot: content });
    assert.equal(records.length, 6, "six files on disk");
    assert.equal(records.filter((r) => r.doc).length, 5, "five of them parsed");
    assert.notEqual(records.length, records.filter((r) => r.doc).length, "the two numbers differ, and only one is true");
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the panel renders totals from the reader and re-judges no finding", () => {
  // #47: the view surfaces lint findings, it does not decide what they mean. Checked statically
  // because the alternative is a view that quietly disagrees with `npm run lint:plan`.
  const src = readFileSync(join(ROOT, "app", "diagnostics-panel.js"), "utf-8");
  assert.match(src, /counts\[type\]/, "totals come from the reader's counts");
  assert.ok(!/severity\s*===\s*["']error["']\s*\?[^:]*:/.test(src.replace(/SEVERITY_TONE[\s\S]*?\};/, "")),
    "the panel must not reclassify a finding's severity");
  for (const forbidden of ["lintProject(", "evaluateStageGate(", "loadArtifacts("])
    assert.ok(!src.includes(forbidden), `the panel must not recompute ${forbidden} — that is the reader's`);
});

test("the reader's diagnostics shape is what the panel expects", () => {
  // A cheap contract check between the two halves, so a rename in one is not a blank region in the
  // other. Read as text: the reader carries `server-only` and cannot be imported here (AST-0033).
  const reader = readFileSync(join(ROOT, "app", "_read", "planning.js"), "utf-8");
  for (const key of ["counts", "artifactCount", "unreadable", "findings"])
    assert.match(reader, new RegExp(`\\b${key}\\b`), `the reader must return ${key}`);
  assert.match(reader, /artifactCount: parsed\.length/, "the artifact total must come from the parsed set");
  assert.ok(!/artifactCount: lint\.records\.length/.test(reader), "never from the file count");
});
