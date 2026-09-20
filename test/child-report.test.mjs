/**
 * The child's report of itself — TSK-0053 (D46), toward ACC-0076.
 *
 * ⚠️ **THIS IS THE CHILD'S OWN ACCOUNT, AND IT IS ONLY EVER USED TO REFUSE.** Every case here is about
 * what must NOT be accepted: a report that is missing, duplicated, malformed, unsorted, out of bounds,
 * or that contradicts either what the parent asked for or what Pi's own events said.
 *
 * ⚠️ **THE BINDING ATTESTATION IS A DIFFERENT FACT AND A DIFFERENT LINE.** Nothing here widens it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHILD_REPORT_TYPE,
  CHILD_REPORT_VERSION,
  REPORT_BOUNDS,
  REPORT_REJECTED,
  buildChildReport,
  judgeChildReport,
  reportedToolsOf,
} from "../lib/specialists/child-report.mjs";

const REQUESTED = { provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "medium" };
const NATIVE = { provider: "openai-codex", model: "gpt-5.6-sol" };

const good = (over = {}) => ({
  type: CHILD_REPORT_TYPE,
  v: CHILD_REPORT_VERSION,
  ...REQUESTED,
  activeTools: ["kiln_create_evidence", "research_search"],
  toolSignatures: { research_search: { input: { properties: { query: {} }, required: ["query"] } } },
  ...over,
});

const judge = (report, requested = REQUESTED, native = NATIVE) => judgeChildReport([report], requested, native);

/* ============================================================== building ====================== */

test("⚠️ D46 the report is built from the child's live view, sorted and reduced", () => {
  const pi = {
    getActiveTools: () => ["research_search", "kiln_create_evidence", "research_search"],
    getAllTools: () => [
      { name: "research_search", description: "Discover candidate sources. DISCOVERY ONLY.", parameters: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "integer" } }, required: ["query"], additionalProperties: false } },
      { name: "kiln_create_evidence", parameters: { properties: { artifact: {} }, required: ["artifact"] } },
      { name: "bash", parameters: { properties: { command: {} }, required: ["command"] } },
    ],
  };
  const ctx = { model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinkingLevel: "medium" };
  const report = buildChildReport({ pi, ctx });

  assert.deepEqual(Object.keys(report).sort(), ["activeTools", "model", "provider", "thinkingLevel", "toolSignatures", "type", "v"]);
  assert.deepEqual(report.activeTools, ["kiln_create_evidence", "research_search"], "duplicates kept, or the list is unsorted");
  assert.equal("bash" in report.toolSignatures, false, "a tool the child does not hold was signed for");

  // ⚠️ REDUCED TO WHAT `verifyChild` COMPARES. A tool's prose never travels.
  assert.deepEqual(report.toolSignatures.research_search, { input: { properties: { maxResults: {}, query: {} }, required: ["query"] } });
  assert.equal(JSON.stringify(report).includes("DISCOVERY ONLY"), false, "a description reached the report");
  assert.equal(JSON.stringify(report).includes("additionalProperties"), false);

  assert.deepEqual(judge(report).accepted, true, JSON.stringify(judge(report)));
});

test("⚠️ D46 a child whose registry cannot be read reports nothing rather than guessing", () => {
  const throwing = {
    getActiveTools: () => {
      throw new Error("no registry");
    },
    getAllTools: () => {
      throw new Error("no registry");
    },
  };
  const report = buildChildReport({ pi: throwing, ctx: {} });
  assert.deepEqual(report.activeTools, []);
  assert.deepEqual(report.toolSignatures, {});
  assert.equal(report.provider, null);
  // And a report with null fields is refused, so an unreadable registry cannot pass as an empty one.
  assert.equal(judge(report).accepted, false);
  assert.equal(judge(report).reason, REPORT_REJECTED.MALFORMED);
});

/* ============================================================== judging ======================= */

test("⚠️ D46 a matching report is accepted, and yields the signatures the gate compares", () => {
  const verdict = judge(good());
  assert.equal(verdict.accepted, true, JSON.stringify(verdict));
  assert.deepEqual(reportedToolsOf(verdict), good().toolSignatures);
  assert.deepEqual(reportedToolsOf({ accepted: false }), {}, "a refused report still yielded signatures");
});

test("⚠️ D46 a missing or duplicated report is refused", () => {
  // ⚠️ A SECOND REPORT IS A CHILD CORRECTING ITS OWN ACCOUNT, which is exactly what must not be possible.
  for (const [reports, reason] of [
    [[], REPORT_REJECTED.ABSENT],
    [null, REPORT_REJECTED.ABSENT],
    [undefined, REPORT_REJECTED.ABSENT],
    [[good(), good()], REPORT_REJECTED.DUPLICATE],
    [[good(), good({ activeTools: [] })], REPORT_REJECTED.DUPLICATE],
  ]) {
    const verdict = judgeChildReport(reports, REQUESTED, NATIVE);
    assert.equal(verdict.accepted, false, JSON.stringify(reports));
    assert.equal(verdict.reason, reason, JSON.stringify(reports));
    assert.deepEqual(reportedToolsOf(verdict), {});
  }
});

test("⚠️ D46 a malformed shape, an unknown field or a wrong version is refused", () => {
  const cases = [
    [null, REPORT_REJECTED.MALFORMED],
    ["a report", REPORT_REJECTED.MALFORMED],
    [[good()], REPORT_REJECTED.MALFORMED],
    [good({ owner: "someone" }), REPORT_REJECTED.UNKNOWN_FIELD],
    [(() => { const { thinkingLevel, ...rest } = good(); return rest; })(), REPORT_REJECTED.UNKNOWN_FIELD],
    [good({ type: "something-else" }), REPORT_REJECTED.MALFORMED],
    [good({ v: 2 }), REPORT_REJECTED.VERSION],
    [good({ provider: "" }), REPORT_REJECTED.MALFORMED],
    [good({ model: 7 }), REPORT_REJECTED.MALFORMED],
    [good({ thinkingLevel: null }), REPORT_REJECTED.MALFORMED],
    [good({ provider: "p".repeat(REPORT_BOUNDS.MAX_FIELD_LENGTH + 1) }), REPORT_REJECTED.MALFORMED],
  ];
  for (const [report, reason] of cases) {
    const verdict = judgeChildReport([report], REQUESTED, NATIVE);
    assert.equal(verdict.accepted, false, JSON.stringify(report));
    assert.equal(verdict.reason, reason, `${JSON.stringify(report)} -> ${verdict.reason}`);
  }
});

test("⚠️ D46 the tool list must be bounded, unique, sorted and well-named", () => {
  const cases = [
    [good({ activeTools: "research_search" }), REPORT_REJECTED.BOUNDS],
    [good({ activeTools: Array.from({ length: REPORT_BOUNDS.MAX_TOOLS + 1 }, (_, i) => `t${i}`) }), REPORT_REJECTED.BOUNDS],
    [good({ activeTools: ["research_search", "research_search"], toolSignatures: {} }), REPORT_REJECTED.DUPLICATE_TOOL],
    // ⚠️ UNSORTED IS ITS OWN REFUSAL: a parent comparing lists must not have to sort a child's claim first.
    [good({ activeTools: ["research_search", "kiln_create_evidence"] }), REPORT_REJECTED.UNSORTED],
    [good({ activeTools: ["has-a-dash"], toolSignatures: {} }), REPORT_REJECTED.MALFORMED],
    [good({ activeTools: [""], toolSignatures: {} }), REPORT_REJECTED.MALFORMED],
    [good({ activeTools: ["x".repeat(REPORT_BOUNDS.MAX_NAME_LENGTH + 1)], toolSignatures: {} }), REPORT_REJECTED.MALFORMED],
    [good({ activeTools: [42], toolSignatures: {} }), REPORT_REJECTED.MALFORMED],
  ];
  for (const [report, reason] of cases) {
    const verdict = judgeChildReport([report], REQUESTED, NATIVE);
    assert.equal(verdict.accepted, false, JSON.stringify(report.activeTools));
    assert.equal(verdict.reason, reason, `${JSON.stringify(report.activeTools)} -> ${verdict.reason}`);
  }
});

test("⚠️ D46 a signature must belong to a claimed tool and stay inside its bounds", () => {
  const big = Object.fromEntries(Array.from({ length: REPORT_BOUNDS.MAX_PROPERTIES + 1 }, (_, i) => [`p${i}`, {}]));
  const cases = [
    // ⚠️ A SIGNATURE FOR A TOOL THE CHILD DOES NOT CLAIM is a contradiction inside one report.
    [good({ toolSignatures: { bash: { input: { properties: {}, required: [] } } } }), REPORT_REJECTED.MALFORMED],
    [good({ toolSignatures: "signatures" }), REPORT_REJECTED.MALFORMED],
    [good({ toolSignatures: { research_search: { input: { properties: null, required: [] } } } }), REPORT_REJECTED.MALFORMED],
    [good({ toolSignatures: { research_search: { input: { properties: {}, required: "query" } } } }), REPORT_REJECTED.MALFORMED],
    [good({ toolSignatures: { research_search: { input: { properties: big, required: [] } } } }), REPORT_REJECTED.BOUNDS],
    [good({ toolSignatures: { research_search: { input: { properties: { ["k".repeat(REPORT_BOUNDS.MAX_NAME_LENGTH + 1)]: {} }, required: [] } } } }), REPORT_REJECTED.MALFORMED],
  ];
  for (const [report, reason] of cases) {
    const verdict = judgeChildReport([report], REQUESTED, NATIVE);
    assert.equal(verdict.accepted, false, JSON.stringify(report.toolSignatures).slice(0, 80));
    assert.equal(verdict.reason, reason, `${JSON.stringify(report.toolSignatures).slice(0, 60)} -> ${verdict.reason}`);
  }
});

test("⚠️ D46 a report that contradicts the request is refused", () => {
  // ⚠️ THE CHILD DOES NOT GET TO CHOOSE. A report naming another selection is not describing this run.
  for (const over of [{ provider: "anthropic" }, { model: "another-model" }, { thinkingLevel: "off" }]) {
    const verdict = judge(good(over));
    assert.equal(verdict.accepted, false, JSON.stringify(over));
    assert.equal(verdict.reason, REPORT_REJECTED.SELECTION_MISMATCH, JSON.stringify(over));
  }
});

test("⚠️ D46 a report that contradicts Pi's own assistant events is refused", () => {
  // ⚠️ TWO INDEPENDENT STATEMENTS. The child's report and Pi's native events are written by the same
  // process, so agreement proves little on its own - but disagreement proves the report is wrong.
  for (const native of [{ provider: "anthropic", model: "gpt-5.6-sol" }, { provider: "openai-codex", model: "some-other" }]) {
    const verdict = judgeChildReport([good()], REQUESTED, native);
    assert.equal(verdict.accepted, false, JSON.stringify(native));
    assert.equal(verdict.reason, REPORT_REJECTED.NATIVE_MISMATCH);
  }
  // Pi saying nothing is not a contradiction: the cross-check is a second opinion, not a requirement.
  assert.equal(judgeChildReport([good()], REQUESTED, {}).accepted, true);
  assert.equal(judgeChildReport([good()], REQUESTED, { provider: null, model: null }).accepted, true);
});

test("⚠️ D46 no report carries a path, a credential or a task", () => {
  const pi = {
    getActiveTools: () => ["research_search"],
    getAllTools: () => [
      {
        name: "research_search",
        description: "Reads C:\\Users\\operator\\secrets and uses sk-ant-PLANTED-REPORT.",
        parameters: { properties: { query: {} }, required: ["query"] },
      },
    ],
  };
  const text = JSON.stringify(buildChildReport({ pi, ctx: { model: { provider: "p", id: "m" }, thinkingLevel: "medium" } }));
  assert.equal(text.includes("sk-ant-PLANTED-REPORT"), false);
  assert.equal(text.includes("operator"), false);
  assert.equal(/[A-Za-z]:(\\\\|\/)/.test(text), false, text.slice(0, 200));
});
