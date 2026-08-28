import "server-only";
import { connection } from "next/server";

import {
  resolveContentRoot,
  loadSchemaSet,
  createValidators,
  readActivatedTypes,
  lintProject,
} from "../server/content.js";
import {
  loadStageDefinitions,
  loadStageAttestations,
  evaluateStageGate,
  readStageDocs,
} from "../server/stages.js";

/**
 * The single application reader — CMP-0012, TSK-0005.
 *
 * ⚠️ EVERY EXPORTED FUNCTION AWAITS `connection()` FIRST, before anything touches a disk. That is
 * DEC-0019's contract, and it is what keeps a route from being prerendered with content frozen into
 * the build: AST-0019 measured that freeze happening with Cache Components both enabled and
 * disabled, so it is not a flag anyone can turn off.
 *
 * ⚠️ NOTHING HERE IMPORTS `lib/` OR TOUCHES `node:fs`. Every read goes through `app/server/*`, which
 * is the guarded door (DEC-0021). REQ-0021 makes that a checked property rather than a convention,
 * and TSK-0006 and TSK-0015 build the checks — until they exist this file is the discipline they
 * will enforce, which is why it is written to be checkable rather than merely correct.
 *
 * ⚠️ THE THREE READS ARE SEPARATE FUNCTIONS ON PURPOSE, not one call returning everything. The stage
 * view puts the criteria and the document behind INDEPENDENT `<Suspense>` boundaries (ACC-0016), and
 * a single combined read would make that impossible — one boundary would have to wait for both, and
 * a page-level fallback satisfies DEC-0019 on paper while buying nothing.
 *
 * ⚠️ Every function is `async` even where the work beneath it is synchronous. The asynchrony is
 * `connection()`, not the filesystem, and a synchronous variant would be a door around the contract.
 */

/**
 * ⚠️ ROOTS ARE PASSED EXPLICITLY RATHER THAN DEFAULTED, and the reason is narrower than it first
 * looked. `lib/`'s `toolRoot()` resolves from `import.meta.url`, so the worry was that bundling
 * would repoint it at a build artefact. MEASURED under `next build` + `next start`: it did not —
 * `toolRoot()` returned the repository root correctly, because Next.js traced `lib/` rather than
 * inlining it. The defaults would have worked.
 *
 * They are still not used, and this is the honest version of why: whether `import.meta.url` survives
 * is a property of the bundler's choices, not a guarantee this project holds. A standalone output,
 * a different builder, or a future Turbopack decision could inline `lib/` and every default derived
 * from `toolRoot()` would then be wrong SILENTLY — pointing at a real directory that is not the
 * project. `process.cwd()` is the project root under `next start` and says so out loud.
 *
 * ⚠️ The content root still honours `PLANNING_CONTENT_DIR` first, so #70's override keeps working.
 * The fallback is the running project's own `planning-content/`, which is not the guess #70 refuses
 * — that refusal is about the TOOL resolving against some other project's content, and an
 * application serving from its own directory is the case that cannot be confused.
 */
function roots() {
  const projectRoot = process.cwd();
  const contentRoot = resolveContentRoot({
    PLANNING_CONTENT_DIR: process.env.PLANNING_CONTENT_DIR ?? `${projectRoot}/planning-content`,
  });
  return { projectRoot, contentRoot };
}

/** The lint context. Not exported: nothing outside this module should be assembling one. */
function context(projectRoot, contentRoot) {
  return {
    contentRoot,
    schemas: loadSchemaSet(`${projectRoot}/schemas`),
    validators: createValidators(`${projectRoot}/schemas`),
    activated: readActivatedTypes(contentRoot),
  };
}

/**
 * The project view's read: derived stage position, every stage's gate state, artifact totals and
 * lint findings.
 *
 * ⚠️ `currentStage` is DERIVED here and stored nowhere (#16). It is the first stage whose gate is
 * not ready, or null when every gate passes — which is a real state meaning "nothing is blocking",
 * not an error.
 *
 * ⚠️ `counts` reports only what this read actually parsed. The truthful-count rule (DEC-0022) is the
 * view's to honour, but it cannot honour it if the reader hands it a total from somewhere else, so
 * the number comes from the records themselves.
 */
export async function readProjectOverview() {
  await connection();
  const { projectRoot, contentRoot } = roots();
  const ctx = context(projectRoot, contentRoot);

  const lint = lintProject(ctx);
  const defs = loadStageDefinitions(projectRoot) ?? {};

  const stages = Object.values(defs).map((def) => {
    const attestations = loadStageAttestations(contentRoot, def.id) ?? {};
    const gate = evaluateStageGate(ctx, def.id, { lint, stageDefinitions: defs, attestations });
    return {
      id: def.id,
      title: def.title ?? def.id,
      ready: gate.ready === true,
      criteria: (def.exitCriteria ?? []).map((c) => ({
        id: c.id,
        describe: c.describe ?? "",
        result: attestations[c.id]?.result ?? "unattested",
      })),
    };
  });

  const counts = {};
  for (const r of lint.records) {
    const type = r.doc?.type;
    if (type) counts[type] = (counts[type] ?? 0) + 1;
  }

  return {
    contentRoot,
    stages,
    currentStage: stages.find((s) => !s.ready)?.id ?? null,
    counts,
    artifactCount: lint.records.length,
    findings: lint.findings,
  };
}

/**
 * One stage's exit criteria with their recorded attestations.
 *
 * ⚠️ Separate from `readStageDocument` so the stage view can put each behind its own boundary. They
 * are separate reads of separate things and there is no reason for one to wait on the other.
 */
export async function readStageCriteria(stageId) {
  await connection();
  const { projectRoot, contentRoot } = roots();
  const ctx = context(projectRoot, contentRoot);

  const defs = loadStageDefinitions(projectRoot) ?? {};
  const def = defs[stageId];
  if (!def) return null;

  const attestations = loadStageAttestations(contentRoot, stageId) ?? {};
  const gate = evaluateStageGate(ctx, stageId, { lint: lintProject(ctx), stageDefinitions: defs, attestations });

  return {
    stageId,
    title: def.title ?? stageId,
    ready: gate.ready === true,
    criteria: (def.exitCriteria ?? []).map((c) => ({
      id: c.id,
      describe: c.describe ?? "",
      result: attestations[c.id]?.result ?? "unattested",
      decidedBy: attestations[c.id]?.decidedBy ?? null,
      reason: attestations[c.id]?.reason ?? null,
    })),
  };
}

/**
 * One stage's document, as authored.
 *
 * ⚠️ Returns the SOURCE, not rendered output. Compilation is CMP-0013's and happens at request time
 * with `@mdx-js/mdx` under DEC-0020's rejection contract — a reader that rendered would be deciding
 * what a document may contain, which is a security boundary and not a read.
 *
 * ⚠️ `readStageDocs` REFUSES a directory containing a file that is neither `.md` nor `.mdx` rather
 * than skipping it, and that refusal is allowed to propagate. A reader that swallowed it would
 * reintroduce exactly the silence AST-0028 found in the publisher.
 */
export async function readStageDocument(stageId) {
  await connection();
  const { contentRoot } = roots();
  const docs = readStageDocs(contentRoot);
  for (const [name, text] of docs) if (name.replace(/\.mdx?$/, "") === stageId) return { name, text };
  return null;
}
