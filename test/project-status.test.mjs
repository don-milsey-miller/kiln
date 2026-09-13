/**
 * What `kiln_project_status` reads beyond handoff readiness — TSK-0048 (G3a), toward ACC-0068.
 *
 * ⚠️ **THIS FILE TESTS THE READER, NOT THE DISCLOSURE BOUNDARY.** Values here are returned exactly as the
 * project holds them; `test/pi-package-project-status.test.mjs` tests what a model receives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  readStageDocument,
  toProjectStatusRefusal,
} from "../lib/project-status.mjs";
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
