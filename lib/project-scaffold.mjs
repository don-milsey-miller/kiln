/**
 * The content initializer's PURE half — what a fresh `planning-content/` contains, as data.
 *
 * ⚠️ **It writes nothing.** Every file the initializer will create is returned as one
 * `Map<relativePath, contents>`, so the complete output of a first run can be inspected, diffed and
 * snapshot-tested without a filesystem. The transactional half (`initialize-project.mjs`) is then
 * only responsible for getting that map onto disk safely — which is a much smaller thing to get
 * right than "generate and write" fused into one pass.
 *
 * ⚠️ **The starter documents are GENERATED FROM `stages/`, never transcribed.** #34 says there is one
 * stage definition set and everything else derives from it. A hand-written stage list here would be
 * the second description of the pipeline that #34 exists to forbid, and it would rot the first time
 * a criterion changed. So the caller passes the loaded definitions in and this module renders them.
 *
 * ⚠️ **It never copies Kiln's own planning content.** The tool ships `planning-content/` because this
 * repository plans itself (#69); that directory is Kiln's OWN history, and seeding a stranger's
 * project from it would hand them somebody else's decisions wearing their project's name. A new
 * project gets empty structure and its own words, and nothing else.
 *
 * ⚠️ **`activated: []` is deliberate and is not an omission.** Artifact type activation is a stage-2
 * decision the agent proposes and the PM approves (#39). Stage 2 is the first point at which a
 * project's shape is knowable, so an initializer that guessed here would be deciding before anything
 * is known — and the guess would arrive already carrying the tool's authority.
 *
 * ⚠️ **Names and descriptions are emitted as QUOTED YAML scalars.** A project called
 * `Migration: phase 2` or `Don't Panic` would otherwise produce a manifest that either fails to parse
 * or — far worse — parses into something else. `yamlString` is the one place that escaping lives.
 */

/** Bumped only when the SHAPE of `state/setup.json` changes, never on a tool release. */
export const SETUP_VERSION = 1;

export const CONTENT_DIR_NAME = "planning-content";
export const SETUP_FILE = "state/setup.json";

/** The marked `.gitignore` block. The markers are what make the block findable, and therefore
 *  addable at most once — see `initialize-project.mjs`. */
export const GITIGNORE_BEGIN = "# Kiln planning tool";
export const GITIGNORE_END = "# End Kiln planning tool";
export const GITIGNORE_RULE = ".planning/";

/** What `steps.gitignore` in `state/setup.json` may say. */
export const GITIGNORE_STATUS = {
  ADDED: "added",
  ALREADY_IGNORED: "already-ignored",
  NOT_A_REPOSITORY: "not-a-git-repository",
};

/**
 * Files whose bytes depend on what the user typed. Drift detection skips them: a project named
 * something else is not a corrupted project, and re-deriving them would mean parsing YAML back out
 * of a manifest the user is entitled to have edited.
 */
export const USER_TEXT_FILES = new Set(["project.yaml", "README.md"]);

/**
 * What a content root MUST still have to be a working project — as opposed to what the scaffold
 * happens to write.
 *
 * ⚠️ **THE TWO LISTS ARE NOT THE SAME, AND THE DIFFERENCE IS THE POINT.** Treating every generated
 * file as required would make ordinary housekeeping look like corruption: a `.gitkeep` exists only to
 * make git track an empty directory, so deleting it once `data/` holds artifacts is correct, and a
 * project that did so would then report damage on every run forever. Equally, `README.md` is prose
 * the user owns — rewriting or removing it breaks nothing.
 *
 * ⚠️ **The DIRECTORIES are required even though their `.gitkeep`s are not.** `data/` missing is a
 * different fact from `data/.gitkeep` missing: the first breaks the artifact layout (#87), the second
 * is a placeholder that has done its job.
 *
 * @param {object} stageDefinitions the loaded `stages/` set — the required stage documents come from
 *   it, so a pipeline change moves this list with it rather than leaving a stale copy here.
 */
export function requiredPaths(stageDefinitions) {
  const stages = orderedStages(stageDefinitions ?? {});
  return {
    files: ["project.yaml", SETUP_FILE, ...stages.map((s) => `stages/${s.id}.md`)].sort(byCodeUnit),
    directories: ["data", "skills-overrides", "stages", "state", "state/stage-attestations"],
  };
}

export class ScaffoldError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScaffoldError";
  }
}

/**
 * One double-quoted YAML scalar, escaped so that no user string can change the manifest's shape.
 *
 * Double-quoted is the right form rather than single-quoted or bare: it is the only YAML scalar
 * style that can carry every character, including a newline, without depending on indentation.
 */
export function yamlString(value) {
  let out = '"';
  for (const ch of String(value ?? "")) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/**
 * ⚠️ CODE-UNIT ORDER, NOT `localeCompare`. Collation is locale-dependent, and the ordering of the
 * generated map decides the order directories are created in and the order a snapshot compares in.
 * A run on a runner with a different ICU locale must produce the identical map.
 */
export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `01-intake` -> 1. The number is part of the definition's id; nothing here maintains a second list. */
function stageNumber(id) {
  const n = Number(String(id).slice(0, 2));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Definitions in pipeline order, which is stage-id order. Deterministic across platforms. */
function orderedStages(stageDefinitions) {
  return Object.values(stageDefinitions).sort((a, b) => byCodeUnit(String(a.id), String(b.id)));
}

/* ------------------------------------------------------------------ manifest */

function manifest({ name, description, schemaVersion, stages }) {
  const stageBlock = stages
    .map(
      (s) =>
        `    - id: ${yamlString(s.id)}\n` +
        `      name: ${yamlString(s.name ?? s.id)}\n` +
        `      decidedBy: ${yamlString(s.decidedBy ?? "unassigned")}\n`
    )
    .join("\n");

  return `# project.yaml — this project's manifest.
#
# Generated by Kiln's content initializer. Everything here is yours; tool updates
# never rewrite it.
#
# Two tiers of state. This file carries the pipeline SHAPE and the project's
# CAPABILITY declarations. Per-document STATUS lives in each document's own
# frontmatter. Shape and capability are project-level; status is document-level.
# Keeping them apart is what stops this file becoming a dumping ground.

# --- Identity -------------------------------------------------------------

name: ${yamlString(name)}
description: ${yamlString(description)}

# --- Content schema version -----------------------------------------------
#
# The version of the CONTENT schema that this file and everything under
# planning-content/ is written against. ONE version for all content: every
# artifact carries this same number in its envelope, and the lint reports any
# record that disagrees with it.
#
# It is a property of the content, not of the tool. It moves on a breaking change
# to the shape of content — never on a tool release. \`git pull\` inside .planning/
# updates the tool; this number is what makes that update safe for content the
# updated tool did not write.
#
# ⚠️ Do not hand-edit it. \`npm run migrate:content -- --apply\` advances the stored
# records and this line together, under one lock. Advancing either alone is how
# the two come to disagree.
schemaVersion: ${schemaVersion}

# --- Pipeline shape -------------------------------------------------------
#
# The stages are a guide, not a fixture. A project declares the set it needs, and
# once that set is determined it is honoured. Projects differ, and a rigid spine
# eventually fits some project badly — the cost of that is a half-filled stage
# nobody believes in.
#
# NOTE what is deliberately absent: what each stage PRODUCES and what makes it
# DONE. Those live in the tool's single stages/ definition set — the app renders
# from it and the skills derive from it. Two hand-maintained descriptions of the
# same pipeline will disagree, and the disagreement surfaces as the agent working
# confidently to exit criteria the app is not checking. This file names stages; it
# does not describe them.

pipeline:
  stages:
${stageBlock}
  gates:
    # The lint warns continuously and blocks at exactly two boundaries. Blocking
    # mid-thought is wrong; blocking at a gate is the entire point of having gates.
    # A lint that blocks while you are drafting gets disabled within a week.
    blockOn:
      - stage-transition
      - handoff

    # Asymmetric on purpose. Later findings legitimately rewrite earlier
    # requirements, so the agent must be able to reach backwards. The constraint on
    # the PM is about ATTENTION rather than permission: the value of a staged
    # process is that it stops you designing a solution during intake.
    agentWriteScope: any-stage
    pmWriteScope: current-stage

# --- Capability declarations ----------------------------------------------

capabilities:

  # Which artifact types this project actually uses.
  #
  # ⚠️ EMPTY ON PURPOSE, AND NOT AN OVERSIGHT. Activation is a stage-2 decision:
  # the agent proposes, the PM approves. Stage 2 is the first point at which this
  # project's shape is knowable, so activating at setup would mean guessing before
  # anything is known — and templates are generated from the activated set, so the
  # guess would immediately become the documents you are asked to fill in.
  #
  # Written by the activation tool. Do not hand-edit this list.
  artifactTypes:
    activated: []

  # A permission boundary, not a preference. This declares which tiers are
  # available; the validation agent enforces the ceiling and may not exceed it.
  # This is the one place an agent spends money and holds credentials, which is why
  # it is a declaration the agent is bound by rather than a habit it might drift
  # out of.
  #
  #   1  Python virtual environment
  #   2  Docker / Docker Compose
  #   3  Cloud CLI + infrastructure-as-code   ← credentials, and real cost
  #
  # Tier 1 only: the conservative default, and the one where a wrong default grants
  # nothing. Raise it deliberately; do not inherit a tier by accident.
  sandboxTiers:
    active:
      - 1

# --- Confidence thresholds ------------------------------------------------
#
# Per step class, not one global number. One number cannot be right for both
# \`cd /opt/app\` and \`rm -rf /var/lib/pgsql/data\`. Too low and the runbook is model
# guesses wearing an evidence layer; too high and nothing ships.
#
# The rungs:
#   1 unverified · 2 source-supported · 3 experimentally-validated
#   4 environment-matched · 5 production-validated
#
# A project may RAISE any threshold. It may never LOWER one — lowering would make
# "rung 3" mean different things in different projects, which destroys the only
# property the ladder has.

confidence:
  thresholds:
    informational: 2
    mutating: 3
    destructive: 4

# --- Deliberately not here ------------------------------------------------
#
# roles:  Roles are DISCOVERED from stage-8 task assignments. The agent
#         recommends, the PM approves, and assignment is by role, never by name.
#         There is no roster to maintain, so there is nothing to declare here.
#
# status: Per-document, in each document's frontmatter. Stage status is DERIVED
#         from artifacts and attestations on every read and is stored nowhere.
`;
}

/* ------------------------------------------------------------------ README */

function readme({ name, stages }) {
  const rows = stages.map((s) => `| \`stages/${s.id}.md\` | ${stageNumber(s.id)}. ${s.name ?? s.id} |`).join("\n");

  return `# ${name} — planning content

**This directory is yours. Tool updates never touch it.**

The tool lives in \`.planning/\` beside this directory and is ignored by this
project's repository; your planning content lives here and is committed. That
separation exists for one reason: the tool has to be able to improve without you
losing or rewriting your project documents.

    your-project/
    ├── .planning/          the tool — a clone; \`git pull\` inside it to update
    └── planning-content/   this directory — your project's documents

## What lives here

| Path | What it is |
|---|---|
| \`project.yaml\` | The manifest — pipeline shape and capability declarations. Start here. |
| \`stages/\` | One document per stage. Starters were generated; the content is yours. |
| \`data/\` | Structured artifacts, one JSON file per artifact. Written by the typed tools. |
| \`state/\` | Stage attestations and the initializer's own setup record. |
| \`skills-overrides/\` | Drop a tuned \`SKILL.md\` here and it wins over the packaged one. |

## The stage documents

| Document | Stage |
|---|---|
${rows}

Each starter states its stage's purpose, its decision owner and its exit criteria.
None of them is filled in, and none of the criteria is attested — an unattested
criterion holds that stage's gate closed, which is the correct starting position
for a project nobody has worked on yet.

## What is NOT here, and why

- **No artifacts.** \`data/\` is empty. Artifacts are created by the typed tools as
  the work happens; a pre-seeded one would be a claim nobody made.
- **No attestations.** A missing attestation means *unattested*, which is the
  truth about a project on its first day. Inventing approval state would open every
  gate on evidence that does not exist.
- **No ID counter.** \`.ids.json\` is created by the allocator on the first
  allocation. A counter written in advance is a high-water mark nothing earned.
- **No activated artifact types.** That is a stage-2 decision — see the comment
  above \`activated:\` in \`project.yaml\`.
- **No \`docs/plan/\`.** The handoff package is generated only after a handoff
  actually succeeds, and it lives beside this directory rather than inside it.

## Two writers, one directory

The app and the agent both write here, and they partition rather than lock: the
app writes frontmatter and state fields, the agent writes body prose and data
files. Different regions of different files means there is nothing to clobber.

Structured files under \`data/\` are the source of truth; stage pages and handoff
documents are readable views of that data.
`;
}

/* ------------------------------------------------------------------ stage starters */

function stageDocument(def) {
  const n = stageNumber(def.id);
  const criteria = def.exitCriteria ?? [];

  const criteriaSection = criteria.length
    ? criteria.map((c) => `- \`${c.id}\` — ${c.describe ?? ""}`).join("\n")
    : "_This stage declares no exit criteria._";

  return `# Stage ${n ?? def.id} — ${def.name ?? def.id}

| | |
|---|---|
| **Stage id** | \`${def.id}\` |
| **Decision owner** | ${def.decidedBy ?? "unassigned"} |

> **Starter document.** Kiln generated this from its stage definition set. Nothing
> below is a finding, a decision, or a claim about this project — replace each
> section with your own material, and delete this quote block once you have.

## Purpose

${def.producesProse ?? "See the stage definition for what this stage is expected to produce."}

## Working notes

_Nothing yet._

<!-- Write this stage's material here. Prose belongs in this document; structured
     artifacts belong in ../data/ and are created by the typed tools, never by
     hand-editing JSON. -->

## Exit criteria

These are the criteria this stage is judged against. They are **guidance while you
work**, not a checklist to tick: each one is discharged by an attestation recorded
against it — \`satisfied\`, \`not-satisfied\`, or \`n/a\` with a reason — by the
decision owner named above.

${criteriaSection}

Nothing here is attested yet, so this stage's gate is closed. That is the correct
starting position: seeing a criterion is not a verdict on it.
`;
}

/* ------------------------------------------------------------------ setup record */

/**
 * ⚠️ NO TIMESTAMP AND NO ABSOLUTE PATH. This file is committed to the user's repository, so
 * anything machine-specific in it would produce a diff on every machine that ran the initializer and
 * would tell a reviewer nothing. It records what was DONE, which is the only part a later run needs.
 */
function setupRecord(gitignoreStatus) {
  return (
    JSON.stringify(
      { setupVersion: SETUP_VERSION, steps: { contentScaffold: "complete", gitignore: gitignoreStatus } },
      null,
      2
    ) + "\n"
  );
}

/* ------------------------------------------------------------------ entry point */

/**
 * Every file a fresh project's `planning-content/` contains, keyed by content-root-relative path
 * with `/` separators. Insertion order is sorted, so two runs produce identical iteration order.
 *
 * @param {object} opts
 * @param {string} opts.name                 the project's name, as the user typed it
 * @param {string} [opts.description]        one or more sentences; may be empty
 * @param {object} opts.stageDefinitions     the loaded `stages/` set — the ONLY source of stages
 * @param {number} opts.schemaVersion        `SCHEMA_VERSION`, passed in rather than imported here
 * @param {string} [opts.gitignoreStatus]    what the initializer did about `.gitignore`
 * @returns {Map<string, string>}
 */
export function buildScaffold({ name, description = "", stageDefinitions, schemaVersion, gitignoreStatus }) {
  if (typeof name !== "string" || name.trim().length === 0)
    throw new ScaffoldError("A project name is required: it is written into the manifest and nothing can derive it.");
  if (typeof description !== "string") throw new ScaffoldError("description must be a string.");
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1)
    throw new ScaffoldError(`schemaVersion must be a positive integer, got ${JSON.stringify(schemaVersion)}.`);
  if (!stageDefinitions || typeof stageDefinitions !== "object" || Object.keys(stageDefinitions).length === 0)
    throw new ScaffoldError(
      "No stage definitions. The starter documents are generated from stages/ and there is nothing to generate from — " +
        "refusing rather than inventing a stage list, which would be a second description of the pipeline (#34)."
    );

  const status = gitignoreStatus ?? GITIGNORE_STATUS.NOT_A_REPOSITORY;
  if (!Object.values(GITIGNORE_STATUS).includes(status))
    throw new ScaffoldError(`Unknown gitignore status ${JSON.stringify(status)}.`);

  const stages = orderedStages(stageDefinitions);
  for (const s of stages)
    if (typeof s.id !== "string" || !/^[0-9]{2}-[a-z0-9-]+$/.test(s.id))
      throw new ScaffoldError(`Stage definition has an unusable id: ${JSON.stringify(s.id)}.`);

  const trimmedName = name.trim();
  const files = new Map();
  files.set("README.md", readme({ name: trimmedName, stages }));
  files.set("data/.gitkeep", "");
  files.set("project.yaml", manifest({ name: trimmedName, description, schemaVersion, stages }));
  files.set("skills-overrides/.gitkeep", "");
  for (const s of stages) files.set(`stages/${s.id}.md`, stageDocument(s));
  files.set(SETUP_FILE, setupRecord(status));
  files.set("state/stage-attestations/.gitkeep", "");

  // Sorted, so the map's iteration order — and therefore the order directories are created in — is
  // a property of the content rather than of the order the branches above happen to run.
  return new Map([...files.entries()].sort(([a], [b]) => byCodeUnit(a, b)));
}
