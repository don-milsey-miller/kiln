/**
 * What `kiln_project_status` reads beyond handoff readiness — TSK-0048 (G3a), toward ACC-0068.
 *
 * ⚠️ **THIS FILE TESTS THE READER, NOT THE DISCLOSURE BOUNDARY.** Values here are returned exactly as the
 * project holds them; `test/pi-package-project-status.test.mjs` tests what a model receives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readActivatedTypes } from "../lib/activation.mjs";
import { ORCHESTRATOR_STATE_REFUSAL, OrchestratorStateError } from "../lib/orchestrator-state.mjs";
import { yamlString } from "../lib/project-scaffold.mjs";
import {
  PROJECT_IDENTITY_UNREADABLE,
  PROJECT_STATUS_MESSAGES,
  PROJECT_STATUS_REFUSAL,
  ProjectStatusRefusal,
  readProjectIdentity,
  readProjectStatus,
  INTAKE_STATE,
  readStageDocument,
  readStageIntake,
  toProjectStatusRefusal,
} from "../lib/project-status.mjs";
import { intakeSection, writeStageDocumentEntry } from "../lib/stage-documents.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { StageDefinitionError } from "../lib/stages.mjs";
import { createValidators } from "../lib/validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = loadSchemaSet(join(ROOT, "schemas"));
const validators = createValidators(join(ROOT, "schemas"));
const SECRET = "sk-ant-api03-READERPLANTEDCREDENTIAL00000";

function contentRootWith(files = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-project-status-"));
  try {
    const contentRoot = join(base, "planning-content");
    mkdirSync(contentRoot, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(contentRoot, rel)), { recursive: true });
      writeFileSync(join(contentRoot, rel), text);
    }
    return { base, contentRoot };
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e;
  }
}

function identityOf(yaml) {
  const f = contentRootWith({ "project.yaml": yaml });
  try {
    return readProjectIdentity(f.contentRoot);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
}

const ctxOf = (contentRoot) => ({ contentRoot, schemas, validators, activated: readActivatedTypes(contentRoot) });

/* ============================================================================ identity (D18) */

test("⚠️ ACC-0068 the scaffold's double-quoted form reads back exactly, every escape included", () => {
  const name = 'Kiln "quoted" \\ back\nline\ttab\rreturn\u0007bell\u007fdel é 😀';
  assert.deepEqual(identityOf(`# header\nname: ${yamlString(name)}\ndescription: ${yamlString("")}\nschemaVersion: 2\n`), {
    name,
    description: "",
    issues: [],
  });
  assert.deepEqual(identityOf('name: "x"  # a comment\r\ndescription: "y"\r\n'), { name: "x", description: "y", issues: [] });
});

test("⚠️ ACC-0068 a conservative one-line plain scalar reads as that string", () => {
  assert.deepEqual(identityOf("name: My plain project\ndescription: Plans the thing, carefully - step by step.\n"), {
    name: "My plain project",
    description: "Plans the thing, carefully - step by step.",
    issues: [],
  });
});

test("⚠️ ACC-0068 folded, multi-line, tagged, typed, malformed and ambiguous YAML is unreadable, never guessed", () => {
  const cases = {
    folded: "name: >\n  folded text\n",
    literal: "name: |\n  literal text\n",
    "double-quoted over two lines": 'name: "starts here\n  and continues"\n',
    "plain continued on the next line": "name: first\n  second\n",
    tagged: "name: !!str tagged\n",
    "single-quoted": "name: 'single'\n",
    "an escape the scaffold never writes": 'name: "\\u0041"\n',
    "a hex escape for a printable character": 'name: "\\x41"\n',
    "a raw control character": 'name: "a\u0007b"\n',
    "text after the closing quote": 'name: "a" b\n',
    "declared twice": 'name: "a"\nname: "b"\n',
    absent: "",
    "nested, not top level": 'meta:\n  name: "a"\n',
    "a mapping inside a plain value": "name: a: b\n",
    "a comment marker inside a plain value": "name: value #maybe\n",
    "a number": "name: 123\n",
    "a boolean": "name: true\n",
    "a null": "name: null\n",
    "a tilde": "name: ~\n",
    empty: "name:\n",
    "no space after the colon": 'name:"a"\n',
    "a flow sequence": "name: [a, b]\n",
  };
  for (const [label, yaml] of Object.entries(cases)) {
    const identity = identityOf(`${yaml}description: "ok"\n`);
    assert.equal(identity.name, null, `${label}: read as ${JSON.stringify(identity.name)}`);
    assert.deepEqual(identity.issues, [{ field: "name", code: PROJECT_IDENTITY_UNREADABLE }], label);
    assert.equal(identity.description, "ok", `${label}: the other field is still read`);
  }
});

test("⚠️ ACC-0068 with no project.yaml both fields are unreadable", () => {
  const f = contentRootWith();
  try {
    assert.deepEqual(readProjectIdentity(f.contentRoot), {
      name: null,
      description: null,
      issues: [
        { field: "name", code: PROJECT_IDENTITY_UNREADABLE },
        { field: "description", code: PROJECT_IDENTITY_UNREADABLE },
      ],
    });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ the Stage 1 document (D19) */

test("⚠️ ACC-0068 the Stage 1 document is read inside the content root, and its absence is a stable refusal", () => {
  const present = contentRootWith({ "stages/01-intake.md": "# Stage 1\n" });
  const absent = contentRootWith();
  const directory = contentRootWith();
  const escaping = contentRootWith();
  try {
    assert.deepEqual(readStageDocument(present.contentRoot, "01-intake"), { stageId: "01-intake", path: "stages/01-intake.md", text: "# Stage 1\n" });

    assert.throws(
      () => readStageDocument(absent.contentRoot, "01-intake"),
      (e) =>
        e instanceof ProjectStatusRefusal &&
        e.code === PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_MISSING &&
        e.message === PROJECT_STATUS_MESSAGES[PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_MISSING] &&
        e.cause?.code === "ENOENT"
    );

    mkdirSync(join(directory.contentRoot, "stages", "01-intake.md"), { recursive: true });
    assert.throws(
      () => readStageDocument(directory.contentRoot, "01-intake"),
      (e) => e instanceof ProjectStatusRefusal && e.code === PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_UNREADABLE && e.cause instanceof Error
    );

    // ⚠️ A stages/ that is a link out of the root is refused, not followed to the file it points at.
    const outside = join(escaping.base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "01-intake.md"), `${SECRET}\n`);
    symlinkSync(outside, join(escaping.contentRoot, "stages"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => readStageDocument(escaping.contentRoot, "01-intake"),
      (e) => e instanceof ProjectStatusRefusal && e.code === PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_UNREADABLE && e.cause?.name === "PathEscapeError"
    );
  } finally {
    for (const f of [present, absent, directory, escaping]) rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ refusals (F101) */

test("⚠️ F101 every failure becomes an authored code and message, with the original error kept only as cause", () => {
  const cases = [
    [new OrchestratorStateError(ORCHESTRATOR_STATE_REFUSAL.NO_DEFINITIONS, "x"), PROJECT_STATUS_REFUSAL.STAGE_DEFINITIONS_MISSING],
    [new OrchestratorStateError(ORCHESTRATOR_STATE_REFUSAL.UNEXPLAINED_GATE, "x"), PROJECT_STATUS_REFUSAL.STAGE_NOT_READY_WITHOUT_FINDING],
    [new StageDefinitionError(`bad at /home/operator/${SECRET}`), PROJECT_STATUS_REFUSAL.STAGE_DEFINITIONS_UNREADABLE],
    [new SyntaxError(`Unexpected token in "${SECRET}"`), PROJECT_STATUS_REFUSAL.STAGE_DEFINITIONS_UNREADABLE],
    [new Error(`Cannot read stage attestations at C:\\Users\\operator\\${SECRET}.json`), PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE],
  ];
  for (const [error, code] of cases) {
    const refusal = toProjectStatusRefusal(error);
    assert.ok(refusal instanceof ProjectStatusRefusal);
    assert.equal(refusal.code, code);
    assert.equal(refusal.message, PROJECT_STATUS_MESSAGES[code], `${code}: the message is authored`);
    assert.equal(refusal.message.includes(SECRET), false);
    assert.equal(refusal.cause, error, `${code}: the original survives only as cause`);
  }
  const already = new ProjectStatusRefusal(PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_MISSING);
  assert.equal(toProjectStatusRefusal(already), already);
});

test("⚠️ ACC-0068 readProjectStatus returns the derived state, identity and document, and refuses through authored codes", () => {
  const fresh = contentRootWith({
    "project.yaml": `name: ${yamlString("Fixture")}\ndescription: ${yamlString("A project.")}\n`,
    "stages/01-intake.md": "# Stage 1\n",
  });
  const brokenAttestations = contentRootWith({
    "project.yaml": `name: ${yamlString("Fixture")}\n`,
    "stages/01-intake.md": "# Stage 1\n",
    "state/stage-attestations/01-intake.json": `${SECRET} {`,
  });
  const noDocument = contentRootWith({ "project.yaml": `name: ${yamlString("Fixture")}\n` });
  const bareTool = mkdtempSync(join(tmpdir(), "kiln-project-status-tool-"));
  const brokenTool = mkdtempSync(join(tmpdir(), "kiln-project-status-tool-"));
  try {
    const status = readProjectStatus(ctxOf(fresh.contentRoot), { toolRoot: ROOT });
    assert.equal(status.orchestration.fresh, true);
    assert.equal(status.orchestration.currentStage.id, "01-intake");
    assert.deepEqual(status.project, { name: "Fixture", description: "A project.", issues: [] });
    assert.deepEqual(status.stageOneDocument, { stageId: "01-intake", path: "stages/01-intake.md", text: "# Stage 1\n" });

    assert.throws(
      () => readProjectStatus(ctxOf(brokenAttestations.contentRoot), { toolRoot: ROOT }),
      (e) =>
        e instanceof ProjectStatusRefusal &&
        e.code === PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE &&
        !e.message.includes(SECRET) &&
        e.cause.message.includes(brokenAttestations.contentRoot),
      "the loader's own error named the file, and only the cause keeps it"
    );

    assert.throws(
      () => readProjectStatus(ctxOf(noDocument.contentRoot), { toolRoot: ROOT }),
      (e) => e instanceof ProjectStatusRefusal && e.code === PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_MISSING
    );

    mkdirSync(join(bareTool, "stages"));
    assert.throws(
      () => readProjectStatus(ctxOf(fresh.contentRoot), { toolRoot: bareTool }),
      (e) => e instanceof ProjectStatusRefusal && e.code === PROJECT_STATUS_REFUSAL.STAGE_DEFINITIONS_MISSING
    );

    mkdirSync(join(brokenTool, "stages"));
    writeFileSync(join(brokenTool, "stages", "01-intake.json"), `{ "id": "01-intake", ${SECRET}`);
    assert.throws(
      () => readProjectStatus(ctxOf(fresh.contentRoot), { toolRoot: brokenTool }),
      (e) => e instanceof ProjectStatusRefusal && e.code === PROJECT_STATUS_REFUSAL.STAGE_DEFINITIONS_UNREADABLE && e.cause instanceof SyntaxError
    );
  } finally {
    for (const f of [fresh, brokenAttestations, noDocument]) rmSync(f.base, { recursive: true, force: true });
    rmSync(bareTool, { recursive: true, force: true });
    rmSync(brokenTool, { recursive: true, force: true });
  }
});

/* ============================================================================ the intake section (TSK-0049) */

const NL_CHAR = String.fromCharCode(10);
const starter = () => `# Stage 1${NL_CHAR}${NL_CHAR}## Purpose${NL_CHAR}${NL_CHAR}What was asked for.${NL_CHAR}${NL_CHAR}${intakeSection()}${NL_CHAR}## Working notes${NL_CHAR}${NL_CHAR}_Nothing yet._${NL_CHAR}`;

/** A content root with a stage document, and the entries recorded into it. */
async function withIntake(document, answers = []) {
  const f = contentRootWith({ "stages/01-intake.md": document });
  for (const [verbatim, interpretation] of answers)
    await writeStageDocumentEntry(f.contentRoot, "01-intake", { verbatim, interpretation });
  f.text = () => readFileSync(join(f.contentRoot, "stages", "01-intake.md"), "utf8");
  return f;
}

test("⚠️ ACC-0069 what the document records is read as structure, and a malformed section is never reported as an empty one", async () => {
  const written = await withIntake(starter(), [
    ["We keep losing the {why} behind decisions.", "Decision rationale is not retained"],
    ["Mostly the architecture ones.", "Architecture decisions first"],
  ]);
  const empty = await withIntake(starter());
  const absent = await withIntake(`# Stage 1${NL_CHAR}${NL_CHAR}## Working notes${NL_CHAR}${NL_CHAR}_Nothing yet._${NL_CHAR}`);
  const framed = await withIntake(starter(), [["an answer", "a reading"]]);
  const labelled = await withIntake(starter(), [["an answer", "a reading"]]);

  try {
    assert.deepEqual(readStageIntake({ stageId: "01-intake", text: written.text() }), {
      stageId: "01-intake",
      state: INTAKE_STATE.RECORDED,
      problem: null,
      total: 2,
      entries: [
        { label: "A1", answer: "We keep losing the {why} behind decisions.", reading: "Decision rationale is not retained" },
        { label: "A2", answer: "Mostly the architecture ones.", reading: "Architecture decisions first" },
      ],
    });

    assert.deepEqual(readStageIntake({ stageId: "01-intake", text: empty.text() }), {
      stageId: "01-intake",
      state: INTAKE_STATE.EMPTY,
      problem: null,
      total: 0,
      entries: [],
    });

    assert.deepEqual(readStageIntake({ stageId: "01-intake", text: absent.text() }), {
      stageId: "01-intake",
      state: INTAKE_STATE.ABSENT,
      problem: "stage-document-anchor-missing",
      total: 0,
      entries: [],
    });

    // ⚠️ `invalid`, NOT `empty`: the document is perfectly readable and structurally wrong, and a model told
    // "nothing recorded" would conclude the conversation had not started.
    const tampered = framed.text().replace("units=9 ", "units=8 ");
    assert.notEqual(tampered, framed.text());
    assert.deepEqual(readStageIntake({ stageId: "01-intake", text: tampered }), {
      stageId: "01-intake",
      state: INTAKE_STATE.INVALID,
      problem: "stage-document-frame-invalid",
      total: 0,
      entries: [],
    });

    const unpaired = labelled.text().replace(`**A1** a reading${NL_CHAR}`, "");
    assert.notEqual(unpaired, labelled.text());
    assert.deepEqual(readStageIntake({ stageId: "01-intake", text: unpaired }), {
      stageId: "01-intake",
      state: INTAKE_STATE.INVALID,
      problem: "stage-document-entries-invalid",
      total: 0,
      entries: [],
    });

    // ⚠️ `unreadable` IS NOT ONE OF THESE STATES. A document that cannot be read refuses the whole call.
    assert.deepEqual(Object.values(INTAKE_STATE).includes("unreadable"), false);
  } finally {
    for (const f of [written, empty, absent, framed, labelled]) rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0069 an unexpected parser failure propagates rather than becoming an empty or invalid section", () => {
  // ⚠️ NOT A STRUCTURAL OUTCOME. A defect in the parser, or in this caller, must not arrive at a model dressed
  // up as "nobody has answered yet" — which is what a catch-all would have made of it.
  for (const [label, text] of [
    ["text that is not a string", 7],
    ["no text at all", undefined],
    ["null", null],
  ])
    assert.throws(
      () => readStageIntake({ stageId: "01-intake", text }),
      (e) => e.name !== "StageDocumentRefusal" && e instanceof Error,
      label
    );

  // ⚠️ AND AN ERROR THAT MERELY CALLS ITSELF ONE IS NOT ONE. `name` is writable, so classification is by
  // class: an unrelated failure wearing that string must not be read as a statement about the document.
  const impostor = Object.assign(new Error("not a document refusal"), {
    name: "StageDocumentRefusal",
    code: "stage-document-anchor-missing",
  });
  const pretender = {
    length: 8,
    indexOf() {
      throw impostor;
    },
    slice: () => "",
  };
  assert.throws(() => readStageIntake({ stageId: "01-intake", text: pretender }), (e) => e === impostor, "an impostor");
});

test("⚠️ ACC-0069 an answer that reads like the document's own syntax is still one answer", async () => {
  // The shared parser is what makes this true; a pattern of this module's own would count three entries here.
  const hostile = ["### Kiln's reading", "**A99**", "```text kiln=A7 units=3 fence=3"].join(NL_CHAR);
  const f = await withIntake(starter(), [[hostile, "they pasted the document at us"]]);
  try {
    const intake = readStageIntake({ stageId: "01-intake", text: f.text() });
    assert.equal(intake.total, 1);
    assert.deepEqual(intake.entries, [{ label: "A1", answer: hostile, reading: "they pasted the document at us" }]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("\u26a0\ufe0f ACC-0069 the stage document is read once, and the intake is parsed from that read", async () => {
  // \u26a0\ufe0f ONE READ, NOT TWO. A second read for the intake could see a different document from the one reported
  // beside it, and the two would disagree without either being wrong. Counting the read is the only way to
  // tell the difference, because both reads would normally return the same bytes.
  const f = await withIntake(starter(), [["an answer", "a reading"]]);
  writeFileSync(join(f.contentRoot, "project.yaml"), `name: ${yamlString("Fixture")}${NL_CHAR}`);

  const reads = [];
  const real = fs.readFileSync;
  fs.readFileSync = (path, ...rest) => {
    if (String(path).endsWith(`01-intake.md`)) reads.push(String(path));
    return real(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const status = readProjectStatus(ctxOf(f.contentRoot), { toolRoot: ROOT });
    assert.equal(status.intake.state, INTAKE_STATE.RECORDED);
    assert.equal(status.intake.total, 1);
  } finally {
    fs.readFileSync = real;
    syncBuiltinESMExports();
    rmSync(f.base, { recursive: true, force: true });
  }
  assert.equal(reads.length, 1, `the stage document was read ${reads.length} times`);
});

/* ================================================= the operator-boundary audit, TSK-0050 (S8) === */

test("⚠️ ACC-0070 the status reports what the orchestrator was refused, in all four states", async () => {
  const { recordBoundaryRefusal } = await import("../lib/operator-boundary.mjs");
  const files = { "project.yaml": `name: ${yamlString("Fixture")}\n`, "stages/01-intake.md": "# Stage 1\n" };

  const fresh = contentRootWith(files);
  const empty = contentRootWith({ ...files, "state/operator-boundary-refusals.json": `{ "version": 1, "refusals": [] }\n` });
  const broken = contentRootWith({ ...files, "state/operator-boundary-refusals.json": `${SECRET} {` });
  try {
    // ⚠️ NOTHING EVER REFUSED AND AN EMPTIED FILE ARE NOT THE SAME STATE. Reporting one for the other would
    // say a boundary had never been tested when its record had in fact been cleared.
    assert.deepEqual(readProjectStatus(ctxOf(fresh.contentRoot), { toolRoot: ROOT }).boundaryRefusals, {
      state: "absent",
      total: 0,
      refusals: [],
    });
    assert.equal(readProjectStatus(ctxOf(empty.contentRoot), { toolRoot: ROOT }).boundaryRefusals.state, "empty");

    // ⚠️ A CORRUPT AUDIT FILE IS A STATE, NOT A REFUSAL OF THE WHOLE CALL, and the file's bytes reach nothing.
    const invalid = readProjectStatus(ctxOf(broken.contentRoot), { toolRoot: ROOT });
    assert.equal(invalid.boundaryRefusals.state, "invalid");
    assert.equal(JSON.stringify(invalid).includes(SECRET), false);

    await recordBoundaryRefusal(fresh.contentRoot, { operation: "set-review-status", target: { artifactType: "task", artifactId: "TSK-0050" } });
    const recorded = readProjectStatus(ctxOf(fresh.contentRoot), { toolRoot: ROOT }).boundaryRefusals;
    assert.equal(recorded.state, "recorded");
    assert.equal(recorded.total, 1);
    assert.equal(recorded.refusals[0].operation, "set-review-status");
    assert.deepEqual(recorded.refusals[0].target, { artifactType: "task", artifactId: "TSK-0050" });
  } finally {
    for (const f of [fresh, empty, broken]) rmSync(f.base, { recursive: true, force: true });
  }
});
