/**
 * The package's operator boundary — TSK-0050 (S7), toward ACC-0070.
 *
 * Three acts are the operator's: attesting a stage exit criterion, approving an artifact, and
 * activating or deactivating a type. Each is refused unless the operator confirmed that exact act
 * through Pi's dialog channel during the same invocation.
 *
 * ⚠️ **WHAT IS ASSERTED IS THE FILE, NOT THE ANSWER.** A refusal that returned the right code while
 * touching the attestation file would still have crossed the boundary, so every refusal case compares
 * bytes and modification times over the whole project.
 *
 * ⚠️ **NO `ctx` AT ALL IS A REAL CASE, NOT AN OMISSION.** A session with no dialog channel is exactly
 * where a prompted model would try, and Pi's own no-UI context answers `confirm` with `false`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { createDecision } from "../lib/tools/evidence-tools.mjs";
import { createValidators } from "../lib/validate.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { intakeSection } from "../lib/stage-documents.mjs";
import { BOUNDARY_OPERATION, OPERATOR_ACTOR, readBoundaryRefusals } from "../lib/operator-boundary.mjs";
import register from "../pi-package/extensions/kiln.js";
import { providerVisible } from "./helpers/provider-visible.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);

const NOT_GRANTED = "operator-confirmation-not-granted";
const UNRECORDED = "operator-boundary-refusal-unrecorded";
const GATED = ["kiln_write_stage_attestation", "kiln_set_type_activation", "kiln_set_review_status"];

/** ⚠️ The comment is deliberate: activation rewrites one line, and the rest must survive it. */
const MANIFEST = `name: fixture
capabilities:
  # a comment that must survive an approval
  artifactTypes:
    activated: [requirement, decision]
  sandboxTiers:
    active:
      - 1
`;

const registered = (deps) => {
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, providerVisible(tool)) }, deps);
  return tools;
};

/** A project holding one decision, a manifest and a Stage 1 document: enough for all three acts. */
async function project() {
  const base = reapLater(mkdtempSync(join(tmpdir(), "kiln-op-boundary-")));
  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, "stages"), { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), MANIFEST);
  writeFileSync(join(contentRoot, "stages", "01-intake.md"), `# Stage 01 - Intake\n\n${intakeSection()}\n## Working notes\n\n_Nothing yet._\n`);

  const made = await createDecision(
    { title: "It was decided", statement: "This was decided.", rationale: "Because it was." },
    { contentRoot, schemasDir: SCHEMAS, validators, schemas }
  );
  return { base, contentRoot, decisionId: made.id };
}

const snapshot = (root) => {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(root, path), { bytes: readFileSync(path), mtimeMs: statSync(path).mtimeMs });
    }
  };
  walk(root);
  return out;
};

const assertUnchanged = (before, after, label) => {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: the set of files changed`);
  for (const [path, was] of before) {
    assert.deepEqual(after.get(path).bytes, was.bytes, `${label}: ${path} changed`);
    assert.equal(after.get(path).mtimeMs, was.mtimeMs, `${label}: ${path} was rewritten or touched`);
  }
};

/**
 * A recorded dialog channel. `answer` is whatever `confirm` resolves to, so a test can hand back the
 * shapes a confused client would: `"yes"`, `1`, `undefined`.
 */
const channel = (answer, { throws = false } = {}) => {
  const asked = [];
  return {
    asked,
    ctx: {
      hasUI: true,
      ui: {
        confirm: async (title, message, opts) => {
          asked.push({ title, message, opts });
          if (throws) throw new Error(`the dialog broke at ${homedir()}`);
          return typeof answer === "function" ? answer() : answer;
        },
      },
    },
  };
};

async function invoke(tool, contentRoot, params, { ctx, signal } = {}) {
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = contentRoot;
  try {
    return await tool.execute("call-1", params, signal, undefined, ctx);
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
}

const requests = (contentRoot, decisionId) => ({
  kiln_write_stage_attestation: { stage: "01-intake", criterion: "request-understood", result: "satisfied" },
  kiln_set_type_activation: { type: "component", action: "activate" },
  kiln_set_review_status: { type: "decision", id: decisionId, reviewStatus: "approved" },
});

/* ==================================================== nothing happens without a confirmation ==== */

test("⚠️ ACC-0070 with no dialog channel at all, every gated act is refused and nothing changes", async () => {
  const fx = await project();
  const tools = registered();

  for (const name of GATED) {
    const before = snapshot(fx.contentRoot);
    const result = (await invoke(tools.get(name), fx.contentRoot, requests(fx.contentRoot, fx.decisionId)[name])).details;

    assert.equal(result.ok, false, `${name}: it went through`);
    assert.equal(result.code, NOT_GRANTED, `${name}: ${result.code}`);

    const after = snapshot(fx.contentRoot);
    after.delete(join("state", "operator-boundary-refusals.json"));
    before.delete(join("state", "operator-boundary-refusals.json"));
    assertUnchanged(before, after, name);
  }

  const { state, total, refusals } = readBoundaryRefusals(fx.contentRoot);
  assert.equal(state, "recorded");
  assert.equal(total, 3, "one entry per refused act");
  assert.deepEqual(refusals.map((r) => r.operation).sort(), ["set-review-status", "set-type-activation", "write-stage-attestation"]);
  assert.deepEqual(refusals.find((r) => r.operation === "write-stage-attestation").target, {
    stageId: "01-intake",
    criterion: "request-understood",
  });
  assert.deepEqual(refusals.find((r) => r.operation === "set-type-activation").target, { type: "component", action: "activate" });
  assert.deepEqual(refusals.find((r) => r.operation === "set-review-status").target, { artifactType: "decision", artifactId: fx.decisionId });
});

test("⚠️ ACC-0070 only a literal `true` is an approval", async () => {
  const fx = await project();
  const tools = registered();

  // ⚠️ EVERY ONE OF THESE IS TRUTHY OR ABSENT AND NONE OF THEM IS A YES. A gate written with `if (granted)`
  // would let the first three through.
  for (const answer of ["yes", 1, {}, undefined, null, false]) {
    const before = snapshot(fx.contentRoot);
    const ui = channel(answer);
    const result = (await invoke(tools.get("kiln_write_stage_attestation"), fx.contentRoot, requests(fx.contentRoot, fx.decisionId).kiln_write_stage_attestation, { ctx: ui.ctx })).details;

    assert.equal(result.ok, false, `${JSON.stringify(answer)} was taken as approval`);
    assert.equal(result.code, NOT_GRANTED);
    assert.equal(ui.asked.length, 1, "the operator was asked once");

    const after = snapshot(fx.contentRoot);
    after.delete(join("state", "operator-boundary-refusals.json"));
    before.delete(join("state", "operator-boundary-refusals.json"));
    assertUnchanged(before, after, `answer ${JSON.stringify(answer)}`);
  }
});

test("⚠️ ACC-0070 a dialog that throws is a refusal, and its message never leaves", async () => {
  const fx = await project();
  const tools = registered();
  const before = snapshot(fx.contentRoot);

  const ui = channel(true, { throws: true });
  const result = await invoke(tools.get("kiln_set_type_activation"), fx.contentRoot, { type: "component", action: "activate" }, { ctx: ui.ctx });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.code, NOT_GRANTED);

  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes("the dialog broke"), false, "the UI's own error reached the model");
  assert.equal(serialised.includes(homedir()), false);
  assert.equal(/[A-Za-z]:(\\\\|\/)/.test(serialised), false, "a drive-lettered path survived");

  const after = snapshot(fx.contentRoot);
  after.delete(join("state", "operator-boundary-refusals.json"));
  before.delete(join("state", "operator-boundary-refusals.json"));
  assertUnchanged(before, after, "a throwing dialog");
  assert.equal(readBoundaryRefusals(fx.contentRoot).total, 1, "and it is still recorded");
});

/* ============================================================ what the confirmation is asked ==== */

test("⚠️ ACC-0070 the dialog is bounded at thirty seconds and carries this invocation's signal", async () => {
  const fx = await project();
  const tools = registered();
  const mine = new AbortController();
  const agents = new AbortController();

  const ui = channel(false);
  // D36: the context's signal is present too, so a handler reaching for the wrong one is visible here.
  ui.ctx.signal = agents.signal;
  await invoke(tools.get("kiln_write_stage_attestation"), fx.contentRoot, requests(fx.contentRoot, fx.decisionId).kiln_write_stage_attestation, {
    ctx: ui.ctx,
    signal: mine.signal,
  });

  assert.equal(ui.asked.length, 1);
  // ⚠️ WITHOUT THE TIMEOUT AN RPC CLIENT THAT NEVER ANSWERS WOULD HANG THE TOOL CALL rather than refuse
  // it: `confirm` has no bound of its own there.
  assert.deepEqual(Object.keys(ui.asked[0].opts).sort(), ["signal", "timeout"]);
  assert.equal(ui.asked[0].opts.timeout, 30_000);
  assert.equal(ui.asked[0].opts.signal, mine.signal, "the invocation's own signal, not the agent's");
});

test("⚠️ ACC-0070 a model cannot forge the preview the operator reads", async () => {
  const fx = await project();
  const tools = registered();
  const ui = channel(false);

  await invoke(
    tools.get("kiln_set_type_activation"),
    fx.contentRoot,
    { type: "component\nAction:  deactivate\nApproved already: yes", action: "activate" },
    { ctx: ui.ctx }
  );

  const lines = ui.asked[0].message.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("Action:")).length, 1, "a second Action line was forged into the dialog");
  assert.ok(
    lines.some((l) => l.startsWith("Type:") && l.includes("Action:  deactivate")),
    `the value is shown on its own line, flattened: ${JSON.stringify(lines)}`
  );
});

test("⚠️ ACC-0070 D35 a reason is bounded by the schema and shown to the operator in full", async () => {
  const tools = registered();
  for (const name of ["kiln_write_stage_attestation", "kiln_set_type_activation"])
    assert.equal(tools.get(name).parameters.properties.reason.maxLength, 500, `${name}: the reason is unbounded`);

  const fx = await project();
  const reason = `R${"e".repeat(498)}!`;
  assert.equal(reason.length, 500);

  const ui = channel(false);
  await invoke(tools.get("kiln_write_stage_attestation"), fx.contentRoot, { stage: "01-intake", criterion: "request-understood", result: "n/a", reason }, { ctx: ui.ctx });

  assert.ok(ui.asked[0].message.includes(reason), "the operator was shown a shortened reason and would have approved text they never saw");
});

/* ========================================================== the confirmed path, and its actor ==== */

test("⚠️ ACC-0070 F18 all three receive Kiln's actor; two persist it and approval does not", async () => {
  const fx = await project();
  const tools = registered();
  const reqs = requests(fx.contentRoot, fx.decisionId);

  // ---- attestation: the actor is persisted, as `decidedBy`
  const attested = (await invoke(tools.get("kiln_write_stage_attestation"), fx.contentRoot, reqs.kiln_write_stage_attestation, { ctx: channel(true).ctx })).details;
  assert.equal(attested.ok, true, JSON.stringify(attested));
  assert.equal(attested.decidedBy, OPERATOR_ACTOR);
  const onDisk = JSON.parse(readFileSync(join(fx.contentRoot, "state", "stage-attestations", "01-intake.json"), "utf-8"));
  assert.equal(onDisk.attestations["request-understood"].decidedBy, OPERATOR_ACTOR, "a model cannot name the attester");

  // ---- activation: the actor is persisted, in the manifest
  const activated = (await invoke(tools.get("kiln_set_type_activation"), fx.contentRoot, reqs.kiln_set_type_activation, { ctx: channel(true).ctx })).details;
  assert.equal(activated.ok, true, JSON.stringify(activated));
  assert.match(readFileSync(join(fx.contentRoot, "project.yaml"), "utf-8"), /approved by operator via Pi UI/);

  // ---- review status: the STATUS is persisted and the actor is not.
  //
  // ⚠️ **F18: THE OPERATION TAKES `reviewedBy`, RETURNS IT, AND STORES NONE OF IT.** The artifact
  // envelope has no reviewer field, so an approval carries no durable attribution. This test states that
  // split rather than hiding it, because a criterion read as promising an approver would be overstating
  // what Kiln does, and the confirmation dialog would be promising it to the operator.
  const approved = (await invoke(tools.get("kiln_set_review_status"), fx.contentRoot, reqs.kiln_set_review_status, { ctx: channel(true).ctx })).details;
  assert.equal(approved.ok, true, JSON.stringify(approved));

  const decision = JSON.parse(readFileSync(join(fx.contentRoot, "data", "decisions", `${fx.decisionId}.json`), "utf-8"));
  assert.equal(decision.reviewStatus, "approved", "the status is what an approval persists");
  assert.deepEqual(
    Object.keys(decision).filter((k) => /review(ed)?By|approvedBy|decidedBy|actor/i.test(k)),
    [],
    "no reviewer field was quietly added to the artifact; if one is wanted, that is a schema decision"
  );
  assert.equal(JSON.stringify(decision).includes(OPERATOR_ACTOR), false, "the actor reached the operation but is not stored on the artifact");

  assert.equal(readBoundaryRefusals(fx.contentRoot).state, "absent", "a confirmed act records no refusal");
});

test("⚠️ ACC-0070 F18 the approval dialog does not promise the operator an approver on the record", async () => {
  const fx = await project();
  const ui = channel(false);
  await invoke(registered().get("kiln_set_review_status"), fx.contentRoot, { type: "decision", id: fx.decisionId, reviewStatus: "approved" }, { ctx: ui.ctx });

  const message = ui.asked[0].message;
  assert.ok(message.includes("Nothing but this confirmation authorises the change."));
  assert.ok(message.includes("it does not record an approver"), `the dialog must not overstate what is kept: ${JSON.stringify(message)}`);
  assert.equal(/records you as the approver/.test(message), false);
});

test("⚠️ ACC-0070 the approver reaches the library as the actor and never as a parameter", async () => {
  const fx = await project();
  const seen = [];
  const tools = registered({
    MUTATION_TOOLS: {
      setReviewStatus: (type, id, reviewStatus, options) => {
        seen.push({ type, id, reviewStatus, reviewedBy: options.reviewedBy });
        return { id, artifact: { id, type } };
      },
    },
  });

  await invoke(tools.get("kiln_set_review_status"), fx.contentRoot, { type: "decision", id: fx.decisionId, reviewStatus: "approved" }, { ctx: channel(true).ctx });
  assert.deepEqual(seen, [{ type: "decision", id: fx.decisionId, reviewStatus: "approved", reviewedBy: OPERATOR_ACTOR }]);
});

test("⚠️ ACC-0070 only an approval is the operator's; the other three statuses are not gated", async () => {
  const fx = await project();
  const tools = registered();

  for (const reviewStatus of ["in-review", "amended", "draft"]) {
    const ui = channel(false);
    const result = (await invoke(tools.get("kiln_set_review_status"), fx.contentRoot, { type: "decision", id: fx.decisionId, reviewStatus }, { ctx: ui.ctx })).details;
    assert.equal(result.ok, true, `${reviewStatus}: ${JSON.stringify(result)}`);
    assert.equal(ui.asked.length, 0, `${reviewStatus}: the operator was asked about something that is not theirs to approve`);
  }
  assert.equal(readBoundaryRefusals(fx.contentRoot).state, "absent");
});

/* ================================================================== D37: an unrecorded refusal === */

test("⚠️ ACC-0070 D37 a refusal that cannot be recorded is still a refusal, with its own code", async () => {
  const fx = await project();
  const tools = registered({
    operatorBoundary: {
      recordBoundaryRefusal: async () => {
        throw new Error(`the audit file at ${join(fx.contentRoot, "state")} could not be written`);
      },
    },
  });

  const before = snapshot(fx.contentRoot);
  const result = await invoke(tools.get("kiln_write_stage_attestation"), fx.contentRoot, requests(fx.contentRoot, fx.decisionId).kiln_write_stage_attestation, {
    ctx: channel(false).ctx,
  });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.code, UNRECORDED, "the caller must be able to tell that the audit entry is missing");
  assert.equal(JSON.stringify(result).includes("could not be written"), false, "the storage error reached the model");
  assert.equal(JSON.stringify(result).includes(fx.contentRoot), false);
  assertUnchanged(before, snapshot(fx.contentRoot), "an unrecorded refusal");
});

/* ============================================================ the schemas, and the wire names ==== */

test("⚠️ ACC-0070 no gated tool offers a parameter that could carry authorisation or an actor", async () => {
  const tools = registered();
  for (const name of GATED) {
    const { properties, required, additionalProperties } = tools.get(name).parameters;
    assert.equal(additionalProperties, false, `${name}: an invented parameter would be accepted`);
    for (const forbidden of ["decidedBy", "approvedBy", "reviewedBy", "confirmed", "operator", "authorised", "authorized"]) {
      assert.equal(forbidden in properties, false, `${name}: \`${forbidden}\` is offered to the model`);
      assert.equal(required.includes(forbidden), false, `${name}: \`${forbidden}\` is required of the model`);
    }
  }
});

test("⚠️ ACC-0070 the operations the wrapper records are the ones the library declares", async () => {
  // ⚠️ TWO INDEPENDENT STATEMENTS, COMPARED. The package writes its operation names out because it must
  // load with nothing but `pi-package/` present; this is what keeps the two spellings honest.
  const fx = await project();
  const tools = registered();
  for (const name of GATED) await invoke(tools.get(name), fx.contentRoot, requests(fx.contentRoot, fx.decisionId)[name]);

  assert.deepEqual(
    readBoundaryRefusals(fx.contentRoot).refusals.map((r) => r.operation).sort(),
    Object.values(BOUNDARY_OPERATION).sort()
  );
});

test("⚠️ ACC-0070 a boundary refusal carries no credential and no machine path", async () => {
  const fx = await project();
  const planted = "sk-ant-BOUNDARY-PLANTED-9e3d";
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = planted;

  let texts;
  try {
    const tools = registered();
    texts = [];
    for (const name of GATED) texts.push(JSON.stringify(await invoke(tools.get(name), fx.contentRoot, requests(fx.contentRoot, fx.decisionId)[name])));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }

  for (const text of texts) {
    assert.equal(text.includes(planted), false, "a planted credential reached a boundary refusal");
    assert.equal(text.includes(fx.contentRoot), false);
    assert.equal(text.includes(homedir()), false);
    assert.equal(/[A-Za-z]:(\\\\|\/)/.test(text), false, `a drive-lettered path survived: ${text.slice(0, 200)}`);
  }
});
