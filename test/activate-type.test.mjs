/**
 * `QST-0010`'s activation operation — the last authorised transition that had no typed path.
 *
 * ⚠️ The guards are the substance. Activation itself is one line of YAML; what makes it an operation
 * rather than an edit is that it **refuses** to activate a type nothing can author, a type no stage
 * produces, or a type the catalogue does not contain — and refuses to deactivate one whose artifacts
 * would be stranded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setTypeActivation } from "../lib/tools/activate-type.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import { ValidationError } from "../lib/validate.mjs";
import { artifactDir } from "../lib/layout.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const STAGES = join(ROOT, "stages");
// ⚠️ loadStageDefinitions takes the TOOL ROOT and appends `stages/`, so this is ROOT, not STAGES.

const MANIFEST = (activated) => `name: fixture
capabilities:
  # a comment that must survive
  artifactTypes:
    activated: [${activated.join(", ")}]
  sandboxTiers:
    active:
      - 1
`;

function fresh(activated = ["requirement", "decision"]) {
  const base = mkdtempSync(join(tmpdir(), "vpw-act-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), MANIFEST(activated));
  return { base, contentRoot, o: { contentRoot, schemasDir: SCHEMAS, toolRoot: ROOT, approvedBy: "pm" } };
}

test("activating writes the list through the one reader, and keeps the manifest's comments", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const r = await setTypeActivation("component", "activate", o);
    assert.equal(r.changed, true);
    assert.ok(r.activated.includes("component"));
    // Reported from a re-read, not from what the function believes it wrote.
    assert.deepEqual(r.activated, readActivatedTypes(contentRoot));
    const text = readFileSync(join(contentRoot, "project.yaml"), "utf-8");
    assert.match(text, /a comment that must survive/);
    assert.match(text, /approved by pm/);
    assert.match(text, /Do not hand-edit this list/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("activation records WHO approved it, and refuses without", async () => {
  const { base, o } = fresh();
  try {
    const { approvedBy, ...anonymous } = o;
    await assert.rejects(() => setTypeActivation("component", "activate", anonymous), /must record who approved it/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a type outside the catalogue is refused, and the message says where that lives", async () => {
  const { base, o } = fresh();
  try {
    await assert.rejects(() => setTypeActivation("sprint", "activate", o), (e) => {
      assert.ok(e instanceof ValidationError);
      assert.match(e.message, /not in the catalogue/);
      // ⚠️ #95: adding a type is a CATALOGUE change and this operation must not perform one.
      assert.match(e.message, /CATALOGUE change/);
      return true;
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a type no stage produces is refused — activation would strand it", async () => {
  const { base, o } = fresh();
  try {
    // `risk` is in the catalogue and has no schema, so authorability fires first; use a stages dir
    // with no producer to reach the reachability guard for a type that IS authorable.
    const fakeRoot = mkdtempSync(join(tmpdir(), "vpw-root-"));
    mkdirSync(join(fakeRoot, "stages"));
    writeFileSync(join(fakeRoot, "stages", "01-intake.json"), JSON.stringify({ id: "01-intake", produces: [], exitCriteria: [] }));
    await assert.rejects(
      () => setTypeActivation("component", "activate", { ...o, toolRoot: fakeRoot }),
      /No stage produces "component"/
    );

    // ...and an ABSENT definition set refuses rather than crashing: #90 makes stages/ the authority,
    // and an absent authority cannot approve.
    const bareRoot = mkdtempSync(join(tmpdir(), "vpw-bare-"));
    await assert.rejects(
      () => setTypeActivation("component", "activate", { ...o, toolRoot: bareRoot }),
      /No stage definitions found/
    );
    rmSync(fakeRoot, { recursive: true, force: true });
    rmSync(bareRoot, { recursive: true, force: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a catalogue type with no schema or tool is refused — that is a capability gap on purpose", async () => {
  const { base, o } = fresh();
  try {
    await assert.rejects(() => setTypeActivation("risk", "activate", o), /no schema/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a type with a schema but NO typed tool is refused", async () => {
  const { base, o } = fresh();
  try {
    // ⚠️ This test exists because falsification found nothing covering it: removing the typed-tool
    // guard broke no test, since every type exercised above had both a schema and a tool. `api-spec`
    // is the real case — a step-3 convention testbed with a schema and no way to author one — so
    // activating it would make it required and unauthorable, which is #94's gap created on purpose.
    await assert.rejects(() => setTypeActivation("api-spec", "activate", o), (e) => {
      assert.match(e.message, /no typed tool/);
      assert.match(e.message, /#88/);
      return true;
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deactivating refuses while artifacts of that type exist", async () => {
  const { base, contentRoot, o } = fresh(["requirement", "decision", "component"]);
  try {
    mkdirSync(join(contentRoot, artifactDir("component")), { recursive: true });
    writeFileSync(join(contentRoot, artifactDir("component"), "CMP-0001.json"), "{}");
    await assert.rejects(() => setTypeActivation("component", "deactivate", o), (e) => {
      assert.match(e.message, /would strand them/);
      assert.match(e.message, /Retire them first/);
      return true;
    });
    // ...and nothing was written.
    assert.ok(readActivatedTypes(contentRoot).includes("component"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deactivating a type with no artifacts succeeds", async () => {
  const { base, contentRoot, o } = fresh(["requirement", "decision", "component"]);
  try {
    const r = await setTypeActivation("component", "deactivate", o);
    assert.equal(r.changed, true);
    assert.equal(readActivatedTypes(contentRoot).includes("component"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("activating twice is a no-op rather than a duplicate", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    await setTypeActivation("component", "activate", o);
    const again = await setTypeActivation("component", "activate", o);
    assert.equal(again.changed, false);
    assert.equal(readActivatedTypes(contentRoot).filter((t) => t === "component").length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("it never touches stages/ or schemas/ — the scope #95 draws", async () => {
  const { base, o } = fresh();
  try {
    const before = readFileSync(join(STAGES, "05-solution-design.json"), "utf-8");
    const schemaBefore = readFileSync(join(SCHEMAS, "component.schema.json"), "utf-8");
    await setTypeActivation("component", "activate", o);
    assert.equal(readFileSync(join(STAGES, "05-solution-design.json"), "utf-8"), before, "stages/ must be untouched");
    assert.equal(readFileSync(join(SCHEMAS, "component.schema.json"), "utf-8"), schemaBefore, "schemas/ must be untouched");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
