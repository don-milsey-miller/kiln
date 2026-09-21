/**
 * A consumer override of a generated stage skill, loaded by the real pinned runtime — TSK-0047, against ACC-0067.
 *
 * ⚠️ **THE ENTRY IS KILN'S, NOT THIS FILE'S.** `.pi/settings.json` is exactly what `mergeSettingsText`
 * produces for a fresh project with Kiln's package entry. Nothing here spells the override entry; the test
 * only checks that the merge put it there, and then asks Pi what it loads.
 *
 * ⚠️ **PI DOES THE LOADING, AND EVERY STATE GETS A FRESH LOADER.** Each observation constructs a new
 * `DefaultResourceLoader` and calls `reload()`, so no state can be answered from an earlier one. No provider
 * is configured, no credential exists, no model turn is taken and nothing touches the network.
 *
 * ⚠️ **PROVENANCE IS THE LOADED FILE PATH.** Which file won is read from each skill's `filePath` and from
 * Pi's own collision diagnostic, which names the winning and the losing file. A name alone would pass
 * whether the override or the packaged skill loaded.
 *
 * ⚠️ **WHAT THIS DOES NOT CLAIM.** Pi 0.84.4 resolves project-settings skill paths ahead of package resources
 * and keeps the first skill with each name. The override wins over the packaged skill; an earlier
 * project-settings skill path with the same identity would outrank Kiln's appended entry (R8), and that is
 * not tested here.
 *
 * ⚠️ **HOME IS THE FIXTURE'S.** Pi scans `~/.agents/skills` and reads `HOME` for it, so each load runs with
 * `HOME` pointed at an empty directory inside the fixture and restored afterwards. The operator's own skills
 * can neither appear in these exact sets nor be read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STATE_MODE } from "../lib/local-state.mjs";
import { PORTABLE_PACKAGE_ENTRY } from "../lib/pi-package-entry.mjs";
import { packageRootFor } from "../lib/pi-package.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { SKILL_OVERRIDE_PATH, mergeSettingsText } from "../lib/pi-settings.mjs";
import { loadStageDefinitions } from "../lib/stages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = await import(resolvePinnedSdk(ROOT).url);
const { DefaultResourceLoader, ProjectTrustStore, hasTrustRequiringProjectResources } = sdk;

const IDENTITY = "kiln-stage-01-intake";
const CONTROL_SKILL = "probe-control";

/** Every skill the package ships, written out rather than read from its declaration. */
const PACKAGE_SKILLS = Object.freeze([
  "kiln-planning",
  "kiln-stage-01-intake",
  "kiln-stage-02-intent-decomposition",
  "kiln-stage-03-discovery",
  "kiln-stage-04-requirement-gaps",
  "kiln-stage-05-solution-design",
  "kiln-stage-06-risk-feasibility",
  "kiln-stage-07-acceptance-criteria",
  "kiln-stage-08-implementation-plan",
  "kiln-stage-09-handoff",
]);

/** The packaged description, stated from the stage definition rather than read back through Pi's parser. */
const PACKAGED_DESCRIPTION =
  `Kiln planning stage 01, ${loadStageDefinitions(ROOT)["01-intake"].name}: its purpose, method, next activity, allowed ` +
  `delegations, mutation and approval boundaries, completion summary, decision owner, outputs and exit criteria ` +
  `as the canonical stage definition declares them. Use when the project's current stage is 01-intake.`;
const OVERRIDE_DESCRIPTION = "A consumer override of stage 01, first version.";
const EDITED_DESCRIPTION = "A consumer override of stage 01, edited version.";

/** The settings a fresh project gets from Kiln's merge. The provider and model are inert labels: nothing is contacted. */
const settingsText = () =>
  mergeSettingsText(null, {
    stateMode: STATE_MODE.USER,
    provider: "no-provider",
    model: "no-model",
    thinkingLevel: "off",
    packageEntry: PORTABLE_PACKAGE_ENTRY,
  });

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * An isolated project holding Kiln's package, Kiln's merged settings and an empty override directory, an agent
 * directory holding one user-scoped control skill, and an empty home. `decision` is the recorded trust decision,
 * or `undefined` for none. Removed by the caller; removed here if building it fails part-way.
 */
function isolated(decision) {
  const root = mkdtempSync(join(tmpdir(), "kiln-override-"));
  try {
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    const home = join(root, "home");
    const pkg = join(project, ".planning", "pi-package");
    const overrides = join(project, "planning-content", "skills-overrides");

    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(overrides, { recursive: true });
    mkdirSync(join(agentDir, "skills", CONTROL_SKILL), { recursive: true });
    mkdirSync(home, { recursive: true });

    // ⚠️ ONLY THE PACKAGE IS COPIED, and the override directory is what the initializer scaffolds: empty but for .gitkeep.
    cpSync(packageRootFor(ROOT), pkg, { recursive: true });
    writeFileSync(join(overrides, ".gitkeep"), "");
    const settings = settingsText();
    writeFileSync(join(project, ".pi", "settings.json"), settings);
    writeFileSync(
      join(agentDir, "skills", CONTROL_SKILL, "SKILL.md"),
      ["---", `name: ${CONTROL_SKILL}`, "description: A user-scoped control that project trust does not gate.", "---", "", "control", ""].join("\n")
    );
    if (decision !== undefined) new ProjectTrustStore(agentDir).set(project, decision);

    return { root, project, agentDir, home, pkg, overrides, settings };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

const packagedPath = (f, name) => join(f.pkg, "skills", name, "SKILL.md");
const overridePath = (f) => join(f.overrides, IDENTITY, "SKILL.md");
const controlPath = (f) => join(f.agentDir, "skills", CONTROL_SKILL, "SKILL.md");

function writeOverride(f, description) {
  mkdirSync(join(f.overrides, IDENTITY), { recursive: true });
  writeFileSync(overridePath(f), ["---", `name: ${IDENTITY}`, `description: ${description}`, "---", "", "Overridden by the consumer.", ""].join("\n"));
}

/** Pi's non-interactive trust rule, composed from the package's root exports, as in the package-load test. */
const trustGate = (f) => async () => {
  if (!hasTrustRequiringProjectResources(f.project)) return true;
  const decision = new ProjectTrustStore(f.agentDir).get(f.project);
  return decision === null ? false : decision;
};

/** What a fresh loader, reloaded now, finds - as plain data. */
async function discover(f) {
  const savedHome = process.env.HOME;
  process.env.HOME = f.home;
  try {
    const loader = new DefaultResourceLoader({ cwd: f.project, agentDir: f.agentDir });
    await loader.reload({ resolveProjectTrust: trustGate(f) });
    const { skills, diagnostics } = loader.getSkills();
    return {
      skills: skills.map((s) => ({ name: s.name, filePath: s.filePath, description: s.description })).sort(byName),
      collisions: diagnostics
        .filter((d) => d.type === "collision")
        .map((d) => ({ name: d.collision?.name, winnerPath: d.collision?.winnerPath, loserPath: d.collision?.loserPath })),
      diagnostics: diagnostics.filter((d) => d.type !== "collision").map((d) => ({ type: d.type, message: d.message, path: d.path })),
    };
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
}

/**
 * One state, asserted completely: the exact set of loaded skills by name and path, exactly one skill with the
 * identity, its path and description, and the collisions Pi reported.
 */
function assertState(found, f, label, { filePath, description, collisions }) {
  const expected = [
    ...PACKAGE_SKILLS.filter((n) => n !== IDENTITY).map((name) => ({ name, filePath: packagedPath(f, name) })),
    { name: IDENTITY, filePath },
    { name: CONTROL_SKILL, filePath: controlPath(f) },
  ].sort(byName);

  assert.deepEqual(found.skills.map(({ name, filePath: p }) => ({ name, filePath: p })), expected, `${label}: the loaded skills and their files`);
  const withIdentity = found.skills.filter((s) => s.name === IDENTITY);
  assert.equal(withIdentity.length, 1, `${label}: exactly one ${IDENTITY}`);
  assert.equal(withIdentity[0].filePath, filePath, `${label}: which ${IDENTITY} file loaded`);
  assert.equal(withIdentity[0].description, description, `${label}: the description Pi parsed`);
  assert.deepEqual(found.collisions, collisions, `${label}: the collisions Pi reported`);
  assert.deepEqual(found.diagnostics, [], `${label}: no other skill diagnostic`);
}

/* ======================================================================== the four states */

test("⚠️ ACC-0067 kiln-stage-01-intake through Pi's real loader: packaged only, override present, override edited, override skill removed", async () => {
  const f = isolated(true);
  try {
    // ⚠️ THE ENTRY UNDER TEST IS THE ONE KILN'S MERGE WROTE.
    const settings = JSON.parse(f.settings);
    assert.deepEqual(settings.skills, [SKILL_OVERRIDE_PATH], "the merge wrote exactly Kiln's override entry");
    assert.deepEqual(settings.packages, [PORTABLE_PACKAGE_ENTRY], "and exactly Kiln's package entry");

    const winner = () => [{ name: IDENTITY, winnerPath: overridePath(f), loserPath: packagedPath(f, IDENTITY) }];

    // (1) packaged only: the override directory exists and holds no skill
    assertState(await discover(f), f, "packaged only", {
      filePath: packagedPath(f, IDENTITY),
      description: PACKAGED_DESCRIPTION,
      collisions: [],
    });

    // (2) override present
    writeOverride(f, OVERRIDE_DESCRIPTION);
    assertState(await discover(f), f, "override present", {
      filePath: overridePath(f),
      description: OVERRIDE_DESCRIPTION,
      collisions: winner(),
    });

    // (3) override edited
    writeOverride(f, EDITED_DESCRIPTION);
    assertState(await discover(f), f, "override edited", {
      filePath: overridePath(f),
      description: EDITED_DESCRIPTION,
      collisions: winner(),
    });

    // (4) override skill removed, while the override directory and the settings entry remain
    rmSync(join(f.overrides, IDENTITY), { recursive: true });
    assert.ok(existsSync(f.overrides), "the override directory remains");
    assert.equal(readFileSync(join(f.project, ".pi", "settings.json"), "utf8"), f.settings, "the settings entry remains, byte for byte");
    assertState(await discover(f), f, "override skill removed", {
      filePath: packagedPath(f, IDENTITY),
      description: PACKAGED_DESCRIPTION,
      collisions: [],
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

/* ======================================================================== controls */

test("⚠️ ACC-0067 control: an absent override directory is silently ignored, and the packaged skill loads", async () => {
  const f = isolated(true);
  try {
    rmSync(f.overrides, { recursive: true });
    assert.equal(existsSync(f.overrides), false);
    assert.deepEqual(JSON.parse(f.settings).skills, [SKILL_OVERRIDE_PATH], "the entry still names the missing directory");

    // No refusal, no warning, no error: the packaged skill loads and nothing is reported.
    assertState(await discover(f), f, "absent override directory", {
      filePath: packagedPath(f, IDENTITY),
      description: PACKAGED_DESCRIPTION,
      collisions: [],
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0067 control: an untrusted project loads neither the package's skills nor the override, while the user-scoped control still loads", async () => {
  for (const [label, decision] of [
    ["no decision recorded", undefined],
    ["an explicit denial", false],
  ]) {
    const f = isolated(decision);
    try {
      writeOverride(f, OVERRIDE_DESCRIPTION);
      const found = await discover(f);

      // ⚠️ THE CONTROL IS WHY THE EMPTY RESULT MEANS ANYTHING: discovery ran and found the user-scoped skill.
      assert.deepEqual(
        found.skills.map(({ name, filePath }) => ({ name, filePath })),
        [{ name: CONTROL_SKILL, filePath: controlPath(f) }],
        `${label}: only the user-scoped control loads`
      );
      assert.deepEqual(found.collisions, [], `${label}: nothing collided, because nothing of the project loaded`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
