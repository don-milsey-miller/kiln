/**
 * The seven fields a canonical stage definition must declare — TSK-0071, toward ACC-0112.
 *
 * ⚠️ **THE LOADER REFUSES; IT NEVER FILLS IN.** A stage skill that says "delegate as appropriate"
 * because its definition was silent reads exactly like one whose definition said so. Every case here
 * takes a definition that loads today, breaks one thing, and asserts the load stops and says which
 * stage and which field.
 *
 * ⚠️ **NO CANONICAL PROSE IS ASSERTED AGAINST THE LOADER.** The approval sentence and the summary
 * format are content, not schema. Their current wording is pinned in the shipped-definitions section
 * at the bottom, where a later definition may change it; the loader itself only requires a non-empty
 * line, and a test that hardcoded the sentence into the loader's contract would freeze the methodology.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STAGES_DIR, STAGE_ACTIVITIES, StageDefinitionError, loadStageDefinitions } from "../lib/stages.mjs";
import { NON_CREATION_WRITE_OPERATIONS, OTHER_WRITE_OPERATIONS, OTHER_WRITE_TOOL_NAMES } from "../lib/tool-wire-names.mjs";
import { ROLES, contractFor } from "../lib/specialists/contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = loadStageDefinitions(REPO);
const STAGE = "03-discovery";

/** One shipped definition, deep-copied, so a case can break exactly one thing in it. */
const copy = (id = STAGE) => JSON.parse(JSON.stringify(SHIPPED[id]));

/**
 * Load a set of one definition from a private root.
 *
 * ⚠️ THE FILE IS WRITTEN AND REMOVED PER CASE. A surviving temporary root would be read by the next
 * run of this file, and a case would pass against material it did not write.
 */
function loadOne(def) {
  const root = mkdtempSync(join(tmpdir(), "kiln-stagedef-"));
  try {
    mkdirSync(join(root, STAGES_DIR));
    writeFileSync(join(root, STAGES_DIR, `${def.id ?? "03-discovery"}.json`), JSON.stringify(def, null, 2));
    return loadStageDefinitions(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Break one thing, and assert the refusal is ABOUT that thing.
 *
 * ⚠️ **THE PREFIX IS EXACT AND THE REASON IS CHECKED, BECAUSE A LOOSER TEST PASSED FOR THE WRONG
 * REASON.** The cross-check refusals quote the other field by name - `delegations` explains itself by
 * mentioning `nextActivity.activities` - so an assertion that merely FOUND the field name anywhere in
 * the message was satisfied by a refusal about something else entirely. Five mutations survived on
 * that, including one that dropped the subsequence rule outright.
 */
function refuses(mutate, field, reason, { id = STAGE } = {}) {
  const def = copy(id);
  mutate(def);
  assert.throws(
    () => loadOne(def),
    (error) => {
      assert.ok(error instanceof StageDefinitionError, `not a StageDefinitionError: ${error?.name}`);
      assert.ok(error.message.startsWith(`${id} · ${field}: `), `refusal is not about ${id} · ${field}: ${error.message}`);
      assert.ok(error.message.includes(reason), `refusal does not say ${JSON.stringify(reason)}: ${error.message}`);
      return true;
    },
    `${field}: the loader accepted it`
  );
}

test("⚠️ ACC-0112 the shipped definitions load, so every case below breaks something real", () => {
  assert.equal(Object.keys(SHIPPED).length, 9);
  assert.deepEqual(loadOne(copy()), { [STAGE]: { ...copy(), id: STAGE } });
});

/* ============================================================ presence ======================== */

test("⚠️ ACC-0112 a missing field is refused, never defaulted", () => {
  for (const field of ["purpose", "method", "nextActivity", "delegations", "mutationBoundary", "approvalBoundary", "completionSummary"])
    refuses((def) => delete def[field], field, "is missing");
});

test("⚠️ F88 purpose is required even when producesProse is there, and may not repeat it", () => {
  // ⚠️ **BORROWING IS INFERENCE BY ANOTHER ROUTE.** `producesProse` says what a stage EMITS. The first
  // generator printed it under Purpose, which reads exactly like an authored purpose and is not one.
  const withProse = copy();
  assert.ok(typeof withProse.producesProse === "string" && withProse.producesProse.length > 0);
  refuses((def) => delete def.purpose, "purpose", "is missing");
  refuses(
    (def) => {
      def.purpose = def.producesProse;
    },
    "purpose",
    "repeats `producesProse`"
  );
});

/* ============================================================ line and list shape ============= */

test("⚠️ ACC-0112 a line must be a single non-empty line", () => {
  for (const [field, set] of [
    ["purpose", (def, v) => (def.purpose = v)],
    ["method.summary", (def, v) => (def.method.summary = v)],
    ["nextActivity.rule", (def, v) => (def.nextActivity.rule = v)],
    ["approvalBoundary.approves", (def, v) => (def.approvalBoundary.approves = v)],
    ["completionSummary.format", (def, v) => (def.completionSummary.format = v)],
  ])
    for (const bad of ["", "   ", "two\nlines", "carriage\rreturn", 7, null, [], {}])
      refuses((def) => set(def, bad), field, "must be a single non-empty line");
});

test("⚠️ ACC-0112 an empty list is silence, not a declaration", () => {
  for (const [field, set] of [
    ["method.steps", (def, v) => (def.method.steps = v)],
    ["nextActivity.constraints", (def, v) => (def.nextActivity.constraints = v)],
    ["mutationBoundary.mayNotTouch", (def, v) => (def.mutationBoundary.mayNotTouch = v)],
    ["approvalBoundary.requires", (def, v) => (def.approvalBoundary.requires = v)],
    ["completionSummary.includes", (def, v) => (def.completionSummary.includes = v)],
  ]) {
    refuses((def) => set(def, []), field, "must name at least one entry");
    refuses((def) => set(def, "a string"), field, "must be an array");
    refuses((def) => set(def, [""]), `${field}[0]`, "must be a single non-empty line");
    refuses((def) => set(def, ["fine", "two\nlines"]), `${field}[1]`, "must be a single non-empty line");
  }
});

test("⚠️ D55 a repeated entry is declared twice and read once", () => {
  refuses((def) => def.method.steps.push(def.method.steps[0]), "method.steps", "repeats");
  refuses((def) => def.nextActivity.constraints.push(def.nextActivity.constraints[0]), "nextActivity.constraints", "repeats");
  refuses((def) => def.completionSummary.includes.push(def.completionSummary.includes[0]), "completionSummary.includes", "repeats");
  refuses((def) => def.approvalBoundary.requires.push(def.approvalBoundary.requires[0]), "approvalBoundary.requires", "repeats");
});

/* ============================================================ closed key sets ================= */

test("⚠️ D55 an unknown key would be accepted and never read, so it is refused", () => {
  for (const [field, set] of [
    ["method.note", (def) => (def.method.note = "x")],
    ["nextActivity.note", (def) => (def.nextActivity.note = "x")],
    ["mutationBoundary.mayCreate", (def) => (def.mutationBoundary.mayCreate = ["evidence"])],
    ["approvalBoundary.approver", (def) => (def.approvalBoundary.approver = "user")],
    ["completionSummary.states", (def) => (def.completionSummary.states = ["x"])],
    ["delegations[0].note", (def) => (def.delegations[0].note = "x")],
  ])
    refuses(set, field, "is not a key this field declares");

  // ⚠️ `mayCreate` IS THE ONE WORTH NAMING. Creation authority is `produces`, and a second list here
  // would be the two-descriptions-of-one-pipeline failure this module opens by warning about.
  refuses((def) => (def.mutationBoundary.mayCreate = []), "mutationBoundary.mayCreate", "is not a key this field declares");
});

test("⚠️ D55 a nested field that is not an object is refused", () => {
  for (const [field, set] of [
    ["method", (def, v) => (def.method = v)],
    ["nextActivity", (def, v) => (def.nextActivity = v)],
    ["mutationBoundary", (def, v) => (def.mutationBoundary = v)],
    ["approvalBoundary", (def, v) => (def.approvalBoundary = v)],
    ["completionSummary", (def, v) => (def.completionSummary = v)],
  ])
    for (const bad of [null, "text", 7, []]) refuses((def) => set(def, bad), field, "must be an object");

  // A missing nested key names the key, not just its parent.
  refuses((def) => delete def.method.steps, "method.steps", "is missing");
  refuses((def) => delete def.nextActivity.activities, "nextActivity.activities", "is missing");
  refuses((def) => delete def.mutationBoundary.mayNotTouch, "mutationBoundary.mayNotTouch", "is missing");
});

/* ============================================================ the activity vocabulary ========= */

test("⚠️ D53 activities are a duplicate-free subsequence, because the order is semantic", () => {
  assert.deepEqual([...STAGE_ACTIVITIES], ["question", "author", "delegate", "attest", "exit"]);

  refuses((def) => (def.nextActivity.activities = []), "nextActivity.activities", "must name at least one activity");
  refuses((def) => (def.nextActivity.activities = "question"), "nextActivity.activities", "must be an array");
  refuses((def) => (def.nextActivity.activities = ["question", "ponder", "exit"]), "nextActivity.activities", "is not one of");
  refuses((def) => (def.nextActivity.activities = ["question", "question", "exit"]), "nextActivity.activities", "out of order or twice");
  // ⚠️ SORTING WOULD HAVE ACCEPTED THIS: a stage claiming it exits before it authors. The reason is
  // asserted because the delegate cross-check would otherwise refuse it too, for a different fact.
  refuses((def) => (def.nextActivity.activities = ["exit", "author"]), "nextActivity.activities", "out of order or twice");

  // A strict subsequence is fine, and so is the whole list.
  for (const activities of [["question", "attest", "exit"], ["author", "exit"], [...STAGE_ACTIVITIES]]) {
    const def = copy();
    def.nextActivity.activities = activities;
    def.delegations = activities.includes("delegate") ? def.delegations : [];
    def.mutationBoundary.mayMutate = [...new Set([...def.mutationBoundary.mayMutate.filter((o) => o !== "writeStageDocument"), ...(activities.includes("question") ? ["writeStageDocument"] : [])])].sort();
    assert.ok(loadOne(def), JSON.stringify(activities));
  }
});

/* ============================================================ delegations ===================== */

test("⚠️ D50 a delegation is checked against the contract, never derived from it", () => {
  refuses((def) => (def.delegations = {}), "delegations", "must be an array");
  refuses((def) => (def.delegations[0].role = "archaeology"), "delegations[0].role", "is not one of");
  refuses((def) => (def.delegations[0].capabilities = "research_search"), "delegations[0].capabilities", "must be an array");

  // The declared set must EQUAL the contract's, sorted and unique. Too few, too many, and the
  // contract's own declaration order are all refusals.
  const required = [...new Set(contractFor("research").requiredCapabilities)].sort();
  refuses((def) => (def.delegations[0].capabilities = required.slice(1)), "delegations[0].capabilities", "contract requires");
  refuses((def) => (def.delegations[0].capabilities = [...required, "research_capability"]), "delegations[0].capabilities", "repeats");
  refuses((def) => (def.delegations[0].capabilities = [...contractFor("research").requiredCapabilities]), "delegations[0].capabilities", "is not sorted");
  refuses((def) => (def.delegations[0].capabilities = [...required].reverse()), "delegations[0].capabilities", "is not sorted");

  // ⚠️ THE CONTRACT'S OWN ORDER IS NOT SORTED, which is exactly why this is a trap worth a test.
  assert.notDeepEqual([...contractFor("research").requiredCapabilities], required);

  // A duplicate role, and a role whose contract requires nothing declaring it explicitly.
  refuses((def) => def.delegations.push({ role: "research", capabilities: required }), "delegations[1].role", "one entry per role");
  const planning = copy("05-solution-design");
  assert.deepEqual(planning.delegations, [{ role: "planning", capabilities: [] }]);
  assert.deepEqual(contractFor("planning").requiredCapabilities, []);
  refuses((def) => (def.delegations[0].capabilities = ["kiln_create_requirement"]), "delegations[0].capabilities", "contract requires", { id: "05-solution-design" });
});

test("⚠️ D62 delegate is allowed if and only if a delegation is declared", () => {
  refuses((def) => (def.delegations = []), "delegations", "is empty while");
  refuses((def) => (def.nextActivity.activities = def.nextActivity.activities.filter((a) => a !== "delegate")), "delegations", "names a delegation while");

  // The other direction, from a stage that declares neither.
  const none = copy("07-acceptance-criteria");
  assert.deepEqual(none.delegations, []);
  assert.equal(none.nextActivity.activities.includes("delegate"), false);
  refuses((def) => def.delegations.push({ role: "planning", capabilities: [] }), "delegations", "names a delegation while", { id: "07-acceptance-criteria" });
});

/* ============================================================ the mutation vocabulary ========= */

test("⚠️ D54 mayMutate names canonical non-creation operations, sorted and unique", () => {
  assert.equal(NON_CREATION_WRITE_OPERATIONS.length, 11);
  assert.deepEqual([...NON_CREATION_WRITE_OPERATIONS], [...NON_CREATION_WRITE_OPERATIONS].sort());

  refuses((def) => (def.mutationBoundary.mayMutate = "linkEvidence"), "mutationBoundary.mayMutate", "must be an array");
  // A wire name is the other vocabulary, and mixing the two is what this table exists to prevent.
  refuses((def) => (def.mutationBoundary.mayMutate = ["kiln_link_evidence"]), "mutationBoundary.mayMutate[0]", "is not a canonical non-creation operation");
  // A creation is `produces`, never here.
  refuses((def) => (def.mutationBoundary.mayMutate = ["createEvidence"]), "mutationBoundary.mayMutate[0]", "is not a canonical non-creation operation");
  refuses((def) => (def.mutationBoundary.mayMutate = ["evidence"]), "mutationBoundary.mayMutate[0]", "is not a canonical non-creation operation");
  refuses((def) => def.mutationBoundary.mayMutate.push(def.mutationBoundary.mayMutate[0]), "mutationBoundary.mayMutate", "repeats");
  refuses((def) => (def.mutationBoundary.mayMutate = [...def.mutationBoundary.mayMutate].reverse()), "mutationBoundary.mayMutate", "is not sorted");
});

test("⚠️ D54 the three non-registry writes have operation identifiers, and the tool names derive from them", () => {
  assert.deepEqual(Object.keys(OTHER_WRITE_OPERATIONS).sort(), ["setTypeActivation", "writeStageAttestation", "writeStageDocument"]);
  // ⚠️ DERIVED, NOT WRITTEN OUT TWICE: the wire names are this table's values.
  assert.deepEqual([...OTHER_WRITE_TOOL_NAMES], Object.values(OTHER_WRITE_OPERATIONS));
  for (const operation of Object.keys(OTHER_WRITE_OPERATIONS)) assert.ok(NON_CREATION_WRITE_OPERATIONS.includes(operation), operation);
});

/* ============================================================ the two iffs and the implication */

test("⚠️ ACC-0112 questioning is allowed if and only if the stage may record an answer", () => {
  // An answer that cannot be recorded is not a question this stage can ask.
  refuses(
    (def) => (def.mutationBoundary.mayMutate = def.mutationBoundary.mayMutate.filter((o) => o !== "writeStageDocument")),
    "mutationBoundary.mayMutate",
    "omits `writeStageDocument`"
  );

  // And the other direction, from the one stage that questions nobody.
  const silent = copy("08-implementation-plan");
  assert.equal(silent.nextActivity.activities.includes("question"), false);
  assert.equal(silent.mutationBoundary.mayMutate.includes("writeStageDocument"), false);
  refuses(
    (def) => (def.mutationBoundary.mayMutate = [...def.mutationBoundary.mayMutate, "writeStageDocument"].sort()),
    "mutationBoundary.mayMutate",
    "allows `writeStageDocument`",
    { id: "08-implementation-plan" }
  );
});

test("⚠️ ACC-0112 an attestation that cannot be written is not one", () => {
  refuses(
    (def) => (def.mutationBoundary.mayMutate = def.mutationBoundary.mayMutate.filter((o) => o !== "writeStageAttestation")),
    "mutationBoundary.mayMutate",
    "omits `writeStageAttestation`"
  );

  // ⚠️ THIS ONE IS AN IMPLICATION, NOT AN IFF. A stage may hold the operation without listing `attest`
  // today; requiring the converse would refuse a definition nobody has decided is wrong.
  const def = copy("08-implementation-plan");
  def.nextActivity.activities = def.nextActivity.activities.filter((a) => a !== "attest");
  assert.ok(loadOne(def), "holding writeStageAttestation without attesting was refused");
});

/* ============================================================ the shipped nine ================ */

test("⚠️ TSK-0071 every shipped definition declares all seven, and they agree with each other", () => {
  for (const [id, def] of Object.entries(SHIPPED)) {
    assert.ok(def.purpose.length > 0, id);
    assert.notEqual(def.purpose, def.producesProse, `${id}: purpose repeats producesProse`);
    assert.ok(def.method.steps.length >= 1, id);
    assert.ok(def.nextActivity.activities.includes("exit"), `${id}: no stage can finish`);
    assert.ok(def.mutationBoundary.mayMutate.includes("writeStageAttestation"), id);
    for (const delegation of def.delegations)
      assert.deepEqual(delegation.capabilities, [...new Set(contractFor(delegation.role).requiredCapabilities)].sort(), `${id}: ${delegation.role}`);
    assert.ok(ROLES.length === 3);
  }
});

test("⚠️ D60 and D61 are content, pinned here rather than in the loader", () => {
  // ⚠️ **THE LOADER REQUIRES A NON-EMPTY LINE AND NOTHING MORE.** These two sentences are canonical
  // instructions the definitions carry, so a later definition may word them differently without the
  // schema changing. Pinning them here is a check on what ships today, not on what is loadable.
  const REQUIRES = "The operator confirms the exact stage attestation or advance through Kiln's interactive confirmation channel during that invocation.";
  const FORMAT = "A concise Markdown handoff with bullets under Completed, Decisions, Open items, and Next activity.";
  for (const [id, def] of Object.entries(SHIPPED)) {
    assert.equal(def.approvalBoundary.requires[0], REQUIRES, id);
    assert.equal(def.completionSummary.format, FORMAT, id);
  }

  // And the loader itself accepts other wording, which is what makes them content rather than schema.
  const other = copy();
  other.approvalBoundary.requires = ["Something else entirely, in one line."];
  other.completionSummary.format = "A table, if a later definition prefers one.";
  assert.ok(loadOne(other), "the loader hardcodes the canonical prose");

  // The loader does not contain either sentence.
  const source = readFileSync(join(REPO, "lib", "stages.mjs"), "utf8");
  assert.equal(source.includes("interactive confirmation channel"), false, "D60's sentence is in the loader");
  assert.equal(source.includes("Open items"), false, "D61's sentence is in the loader");
});
