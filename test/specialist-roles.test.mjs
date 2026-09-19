/**
 * The three role definitions and what they derive — TSK-0051 (S11), toward ACC-0072 and ACC-0073.
 *
 * ⚠️ **THE TOOL LIST IS DERIVED, AND THESE TESTS SAY SO INDEPENDENTLY.** They rebuild the expected list
 * from `WRITE_BOUNDARY`'s observable effects and the wire-name map rather than reading `contract.tools`
 * and asserting it equals itself.
 *
 * ⚠️ **A ROLE IS NOT OFFERED A READ-ONLY TOOL, ON PURPOSE.** A specialist receives a task-scoped payload
 * from the delegation runtime; `kiln_project_status` would show it the whole project and weaken that
 * boundary. A role that later needs one adds the requirement to the contract, and these files regenerate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ROLES, contractFor } from "../lib/specialists/contract.mjs";
import { AUTHORED_FIELDS, ROLE_PROSE } from "../lib/specialists/roles.mjs";
import {
  FRONTMATTER_KEYS,
  GENERATED_NOTICE,
  RENDER_REFUSAL,
  RoleRenderRefusal,
  SECTIONS,
  SPECIALISTS_DIR,
  renderRole,
  renderRoles,
  specialistName,
} from "../lib/specialists/render.mjs";
import { CREATE_TOOL_NAMES, MUTATION_TOOL_NAMES } from "../lib/tool-wire-names.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const onDisk = (role) => readFileSync(join(ROOT, SPECIALISTS_DIR, `${role}.md`), "utf8");

/** The frontmatter block, read the way the checker will: line one is `---`, and it closes. */
function frontmatter(text) {
  const lines = text.split("\n");
  assert.equal(lines[0], "---", "the frontmatter must begin on line one, or it is not frontmatter at all");
  const close = lines.indexOf("---", 1);
  assert.ok(close > 0, "the frontmatter does not close");
  return { lines: lines.slice(1, close), body: lines.slice(close + 1).join("\n") };
}

/** The scalar keys and the tool sequence, from the block. */
function parsed(text) {
  const { lines } = frontmatter(text);
  const keys = [];
  const values = {};
  const tools = [];
  let inTools = false;
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    if (inTools && line.startsWith("  - ")) {
      tools.push(JSON.parse(line.slice(4)));
      continue;
    }
    inTools = false;
    const at = line.indexOf(":");
    assert.ok(at > 0, `not a key line: ${JSON.stringify(line)}`);
    const key = line.slice(0, at);
    keys.push(key);
    const rest = line.slice(at + 1).trim();
    if (rest === "") inTools = true;
    else values[key] = JSON.parse(rest);
  }
  return { keys, values, tools };
}

/* ======================================================= what the contract derives ============ */

test("⚠️ ACC-0072 each role's tools are its capabilities and its write boundary, and nothing else", () => {
  for (const role of ROLES) {
    const c = contractFor(role);
    const expected = [
      ...[...c.requiredCapabilities].sort(),
      ...c.writeBoundary.create.map((t) => CREATE_TOOL_NAMES[t]).sort(),
      ...c.writeBoundary.mutate.map((m) => MUTATION_TOOL_NAMES[m]).sort(),
    ];
    assert.deepEqual([...c.tools], expected, `${role}: the derived list is not the contract's own`);
    assert.equal(new Set(c.tools).size, c.tools.length, `${role}: a tool is listed twice`);
    assert.ok(c.tools.length > 0, `${role}: derives no tools at all`);
  }
});

test("⚠️ ACC-0072 no role is offered a read-only tool", () => {
  // ⚠️ THE SPECIALIST SEES A TASK PAYLOAD, NOT THE PROJECT. If one of these ever appears, it is because
  // somebody added it to the contract, and that is a decision this test forces into the open.
  const readOnly = ["kiln_project_status", "kiln_lint", "kiln_read_stage_attestations", "kiln_capability", "kiln_read_artifact"];
  for (const role of ROLES)
    for (const name of readOnly)
      assert.equal(contractFor(role).tools.includes(name), false, `${role} is offered ${name}`);
});

test("⚠️ ACC-0072 an unsound contract derives no tools rather than a name nothing registers", () => {
  // The three roles are sound today, which is what makes the guard's shape worth stating: `tools` is
  // empty exactly when the contract reports a problem, and the renderer refuses on both conditions.
  for (const role of ROLES) {
    const c = contractFor(role);
    const sound = c.unimplemented.length === 0 && c.unknownMutations.length === 0;
    assert.equal(sound, true, `${role}: ${JSON.stringify({ unimplemented: c.unimplemented, unknownMutations: c.unknownMutations })}`);
    assert.equal(c.tools.length > 0, sound);
    assert.deepEqual(c.undefinedCapabilities, [], `${role} requires a capability nothing defines`);
  }
});

/* ============================================================ the rendered shape ============== */

test("⚠️ D43 the frontmatter begins on line one, with the warning inside it", () => {
  for (const role of ROLES) {
    const text = renderRole(role);
    assert.ok(text.startsWith("---\n"), `${role}: something precedes the frontmatter`);
    const { lines } = frontmatter(text);
    assert.equal(lines[0], GENERATED_NOTICE, `${role}: the warning is not the first line inside the block`);
    assert.ok(GENERATED_NOTICE.startsWith("#"), "the warning must be a YAML comment");
  }
});

test("⚠️ D44 every scalar is JSON-quoted, so ordinary punctuation cannot break the file", () => {
  for (const role of ROLES) {
    const { values } = parsed(renderRole(role));
    assert.equal(values.name, specialistName(role));
    assert.equal(values.role, role);
    assert.equal(values.description, ROLE_PROSE[role].description);
  }

  // A description carrying the punctuation that breaks bare YAML still round-trips.
  const hostile = '# not a comment: "quoted", - dashed, and a trailing \\ backslash';
  const line = `description: ${JSON.stringify(hostile)}`;
  assert.equal(JSON.parse(line.slice("description:".length).trim()), hostile);
});

test("⚠️ ACC-0073 the frontmatter key set is closed, so no role can declare a model", () => {
  for (const role of ROLES) {
    const text = renderRole(role);
    assert.deepEqual(parsed(text).keys, [...FRONTMATTER_KEYS], `${role}: the key set changed`);
    for (const forbidden of ["provider", "model", "thinkingLevel", "thinking", "reasoning", "apiKey", "baseUrl"])
      assert.equal(new RegExp(`^${forbidden}:`, "m").test(text), false, `${role} declares ${forbidden}`);
  }
});

test("⚠️ the rendered tools are exactly the contract's, in the contract's order", () => {
  for (const role of ROLES) assert.deepEqual(parsed(renderRole(role)).tools, [...contractFor(role).tools], role);
});

test("⚠️ every section is present, in a fixed order, and the forbidden actions are the contract's own", () => {
  for (const role of ROLES) {
    const text = renderRole(role);
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, SECTIONS.map((s) => s.heading), `${role}: the sections changed`);
    for (const line of contractFor(role).forbidden) assert.ok(text.includes(`- ${line}`), `${role}: the contract forbids ${JSON.stringify(line)} and the file does not say so`);
  }
});

test("⚠️ authored prose may not restate anything the contract owns", () => {
  for (const role of ROLES) {
    assert.deepEqual(Object.keys(ROLE_PROSE[role]).sort(), [...AUTHORED_FIELDS].sort(), `${role}: the authored field set changed`);
    // A tool name in the prose would be a second, unchecked statement of the allowlist.
    const prose = JSON.stringify(ROLE_PROSE[role]);
    for (const name of [...Object.values(CREATE_TOOL_NAMES), ...Object.values(MUTATION_TOOL_NAMES)])
      assert.equal(prose.includes(name), false, `${role}'s prose names ${name}; the contract owns the tool list`);
  }
});

/* ============================================================ the renderer's refusals ========= */

test("⚠️ the renderer refuses rather than writing a definition it cannot stand behind", () => {
  assert.throws(
    () => renderRole("archivist"),
    (e) => e instanceof RoleRenderRefusal && e.code === RENDER_REFUSAL.PROSE_MISSING
  );
});

/* ============================================================ the files on disk =============== */

test("⚠️ the three files on disk are the ones the renderer produces, byte for byte", () => {
  const rendered = renderRoles(ROLES);
  assert.deepEqual([...rendered.keys()].sort(), ROLES.map((r) => `${SPECIALISTS_DIR}/${r}.md`).sort());
  for (const role of ROLES) assert.equal(onDisk(role), rendered.get(`${SPECIALISTS_DIR}/${role}.md`), `${SPECIALISTS_DIR}/${role}.md is stale`);
});

test("⚠️ no role definition carries a path, a credential or a model name", () => {
  for (const role of ROLES) {
    const text = onDisk(role);
    assert.equal(/[A-Za-z]:[\\/]/.test(text), false, `${role}: a drive-lettered path`);
    assert.equal(/\/(home|Users)\//.test(text), false, `${role}: a home directory`);
    for (const needle of ["sk-ant", "gpt-", "claude-", "ANTHROPIC", "TAVILY", "OPENAI"])
      assert.equal(text.includes(needle), false, `${role}: the file carries ${needle}`);
  }
});
