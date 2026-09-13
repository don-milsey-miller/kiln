/**
 * Kiln's package, loaded by the real pinned runtime — TSK-0043, against ACC-0063.
 *
 * ⚠️ **THE RUNTIME DOES THE DISCOVERING, NOT THIS FILE.** Each case builds an isolated project and
 * agent directory, copies `pi-package/` into `<project>/.planning/pi-package/`, writes the portable
 * package entry into `.pi/settings.json`, and then asks the pinned package's own
 * `DefaultResourceLoader` what it found. Nothing is simulated and no model request is made: no
 * provider is configured, no credential exists, and the loader never reaches inference.
 *
 * ⚠️ **THE TRUST GATE IS PI'S; THE POLICY IS RESTATED FROM ROOT EXPORTS.** `reload()` applies
 * whatever `resolveProjectTrust` returns — proved below, since the same project loads or does not on
 * that answer alone. Pi's own `resolveProjectTrusted` is internal, so the callback here composes the
 * two root exports it is made of: `hasTrustRequiringProjectResources`, then the decision in
 * `ProjectTrustStore`, and no UI to ask, which is Pi's documented non-interactive answer. That
 * restatement is the one thing here that is not Pi's own code, and it is why the untrusted case
 * carries a control.
 *
 * ⚠️ **THE CONTROL IS USER-SCOPED AND OWNED BY NOBODY ELSE.** A skill in the agent directory is not
 * gated by project trust, so an untrusted run that discovers it has reached resource discovery and
 * chosen not to load the project's package — rather than having exited early, which would make the
 * empty result mean nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { PORTABLE_PACKAGE_ENTRY } from "../lib/pi-package-entry.mjs";
import { packageRootFor } from "../lib/pi-package.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = await import(resolvePinnedSdk(ROOT).url);
const { DefaultResourceLoader, ProjectTrustStore, hasTrustRequiringProjectResources } = sdk;

const CONTROL_SKILL = "probe-control";

/**
 * An isolated project with Kiln's package installed into it, and an agent directory holding one
 * user-scoped control skill. `mutate` may break the copied package for the negative cases.
 */
function isolated(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-pkg-load-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const pkg = join(project, ".planning", "pi-package");

  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(project, ".planning"), { recursive: true });
  mkdirSync(join(agentDir, "skills", CONTROL_SKILL), { recursive: true });

  // ⚠️ ONLY THE PACKAGE IS COPIED. Nothing else of this repository reaches the fixture.
  cpSync(packageRootFor(ROOT), pkg, { recursive: true });
  writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ packages: [PORTABLE_PACKAGE_ENTRY] }, null, 2)
  );
  writeFileSync(
    join(agentDir, "skills", CONTROL_SKILL, "SKILL.md"),
    ["---", `name: ${CONTROL_SKILL}`, "description: A user-scoped control that project trust does not gate.", "---", "", "control", ""].join("\n")
  );

  mutate({ root, project, agentDir, pkg });
  return { root, project, agentDir, pkg };
}

/** Pi's non-interactive trust rule, composed from the package's root exports. */
const trustGate = (project, agentDir) => async () => {
  if (!hasTrustRequiringProjectResources(project)) return true;
  const decision = new ProjectTrustStore(agentDir).get(project);
  // No UI exists here, and Pi's answer with nothing recorded and nobody to ask is "not trusted".
  return decision === null ? false : decision;
};

/** What the runtime discovered, as plain data. */
async function discover({ project, agentDir }, decision) {
  if (decision !== undefined) new ProjectTrustStore(agentDir).set(project, decision);
  const loader = new DefaultResourceLoader({ cwd: project, agentDir });
  await loader.reload({ resolveProjectTrust: trustGate(project, agentDir) });

  const extensions = loader.getExtensions();
  const byName = (a, b) => (a.name < b.name ? -1 : 1);
  return {
    extensions: extensions.extensions.map((e) => ({
      resolvedPath: e.resolvedPath,
      source: e.sourceInfo?.source ?? null,
      scope: e.sourceInfo?.scope ?? null,
      tools: [...e.tools.keys()].sort(),
      commands: e.commands.size,
      handlers: e.handlers.size,
    })),
    errors: extensions.errors.map((e) => ({ path: e.path, error: String(e.error) })),
    skills: loader
      .getSkills()
      .skills.map((s) => ({ name: s.name, filePath: s.filePath, scope: s.sourceInfo?.scope ?? null }))
      .sort(byName),
    prompts: loader
      .getPrompts()
      .prompts.map((p) => ({ name: p.name, filePath: p.filePath }))
      .sort(byName),
  };
}

const controlSkill = (agentDir) => ({
  name: CONTROL_SKILL,
  filePath: join(agentDir, "skills", CONTROL_SKILL, "SKILL.md"),
  scope: "user",
});

/* ============================================ trusted =========================================== */

test("⚠️ ACC-0063 a trusted project loads exactly kiln, kiln-planning and kiln-start, from the package", async () => {
  const fixture = isolated();
  try {
    const found = await discover(fixture, true);

    // ⚠️ EXACT SETS AND EXACT PATHS. `includes` would pass against a package that also loaded
    // something nobody declared, which is the drift ACC-0063 exists to catch.
    assert.deepEqual(found.errors, [], "the extension loaded with no error");
    assert.deepEqual(found.extensions, [
      {
        resolvedPath: join(fixture.pkg, "extensions", "kiln.js"),
        source: PORTABLE_PACKAGE_ENTRY,
        scope: "project",
        // ⚠️ WHAT PI ACTUALLY HOLDS after loading: the two read tools, by name, registered into the
        // session rather than merely declared in a file.
        tools: [
          "kiln_capability",
          "kiln_create_acceptance_criterion",
          "kiln_create_assertion",
          "kiln_create_component",
          "kiln_create_decision",
          "kiln_create_evidence",
          "kiln_create_question",
          "kiln_create_requirement",
          "kiln_create_runbook_step",
          "kiln_create_task",
          "kiln_link_evidence",
          "kiln_link_trace",
          "kiln_lint",
          "kiln_project_status",
          "kiln_read_stage_attestations",
          "kiln_resolve_question",
          "kiln_revise_artifact",
          "kiln_set_lifecycle",
          "kiln_set_review_status",
          "kiln_set_type_activation",
          "kiln_unlink_evidence",
          "kiln_unlink_trace",
          "kiln_write_stage_attestation",
          "research_capability",
          "research_fetch",
          "research_search",
          "validation_capability",
          "validation_run",
        ],
        commands: 0,
        handlers: 0,
      },
    ]);

    assert.deepEqual(found.skills, [
      { name: "kiln-planning", filePath: join(fixture.pkg, "skills", "kiln-planning", "SKILL.md"), scope: "project" },
      controlSkill(fixture.agentDir),
    ]);

    assert.deepEqual(found.prompts, [
      { name: "kiln-start", filePath: join(fixture.pkg, "prompts", "kiln-start.md") },
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

/* ============================================ untrusted ========================================= */

test("⚠️ ACC-0063 without trust none of the three is discovered, while the user-scoped control still is", async () => {
  for (const [label, decision] of [
    ["no decision recorded", undefined],
    ["an explicit denial", false],
  ]) {
    const fixture = isolated();
    try {
      const found = await discover(fixture, decision);

      assert.deepEqual(found.extensions, [], `${label}: the package's extension must not load`);
      assert.deepEqual(found.errors, [], `${label}: and not loading is not an error`);
      assert.deepEqual(found.prompts, [], `${label}: the package's prompt must not be discovered`);

      // ⚠️ THE CONTROL, AND WHY THE EMPTY RESULT ABOVE MEANS ANYTHING: discovery ran and found the
      // user-scoped skill. An early exit would have produced the same empty package result.
      assert.deepEqual(found.skills, [controlSkill(fixture.agentDir)], `${label}: the control must remain visible`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

/* ============================================ the entry point really loads ====================== */

test("⚠️ ACC-0063 the entry point is imported, not merely named: breaking it is reported as a load failure", async () => {
  // ⚠️ **THIS IS THE PROOF THAT `.js` IS LOADED AND ITS JSON IMPORT RESOLVED.** A manifest that was
  // only parsed would report the same success either way. Each fixture below breaks one thing the
  // loading of this file depends on, and the runtime reports it against that file's path.
  const cases = [
    [
      "its JSON import cannot resolve",
      ({ pkg }) => rmSync(join(pkg, "signature.json")),
      /signature\.json/,
    ],
    [
      "its JavaScript cannot be parsed",
      ({ pkg }) => appendFileSync(join(pkg, "extensions", "kiln.js"), "\nthis is not javascript(((\n"),
      /parse|unexpected|missing/i,
    ],
  ];

  for (const [label, breakIt, expected] of cases) {
    const fixture = isolated(breakIt);
    try {
      const found = await discover(fixture, true);

      assert.equal(found.errors.length, 1, `${label}: exactly one load failure`);
      assert.equal(found.errors[0].path, join(fixture.pkg, "extensions", "kiln.js"), `${label}: reported against the entry point`);
      assert.match(found.errors[0].error, expected, label);
      assert.deepEqual(found.extensions, [], `${label}: nothing loaded`);

      // ⚠️ AND THE PACKAGE ITSELF WAS STILL FOUND: the skill and prompt are there, so what failed is
      // the module, not the package's discovery. Without this the case would prove only that
      // something went wrong somewhere.
      assert.deepEqual(found.skills.map((s) => s.name), ["kiln-planning", CONTROL_SKILL], label);
      assert.deepEqual(found.prompts.map((p) => p.name), ["kiln-start"], label);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("⚠️ ACC-0063 what loaded is the file the manifest declares", async () => {
  const fixture = isolated();
  try {
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(join(fixture.pkg, "package.json"), "utf-8")
    );
    const found = await discover(fixture, true);
    const declared = manifest.pi.extensions[0].replace(/^\.\//, "");

    assert.equal(found.extensions.length, 1);
    assert.equal(
      found.extensions[0].resolvedPath,
      join(fixture.pkg, ...declared.split("/")),
      "the loaded file is the one the manifest names, not one Pi found some other way"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
