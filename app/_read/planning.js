import "server-only";
import { connection } from "next/server";

import { resolveContentRoot } from "../server/paths.js";
import {
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
 * ⚠️ THE CONTENT ROOT IS THE SHARED RESOLVER'S ANSWER, WITH NO FALLBACK OF ITS OWN, AND THE FALLBACK
 * THAT USED TO BE HERE WAS WRONG IN THE ONLY LAYOUT THAT MATTERS. It substituted
 * `<cwd>/planning-content` when `PLANNING_CONTENT_DIR` was unset, on the reasoning that "an
 * application serving from its own directory is the case that cannot be confused". In a consumer
 * install it is precisely the confused case: `next start` runs with its cwd inside `.planning/`, so
 * `<cwd>/planning-content` is the TOOL's own shipped content — a complete, valid, parseable planning
 * project belonging to somebody else. That is #70's failure verbatim, and the reader would have
 * rendered it without a single finding.
 *
 * The one rule is `<toolRoot>/../planning-content`, honouring `PLANNING_CONTENT_DIR` first, and the
 * launcher always sets that variable. An unset variable and a missing sibling now REFUSES, which is
 * a visible failure rather than a plausible wrong answer.
 *
 * `projectRoot` keeps coming from `process.cwd()`: it locates `schemas/` and `stages/`, which are
 * TOOL-side, and under `next start` the cwd is the tool root — the thing being served.
 */
export function planningRoots() {
  const projectRoot = process.cwd();
  const contentRoot = resolveContentRoot(process.env);
  return { projectRoot, contentRoot };
}

/**
 * ⚠️ EXPORTED SINCE TSK-0012, and the export is the point rather than a convenience. The review
 * WRITE has to reach the same content root this file reads from, and two independent resolutions
 * that agreed today would drift silently: the page would read one directory while the write went to
 * another, so an approval would appear not to take effect with nothing to say which half was wrong.
 * One definition, both callers.
 *
 * ⚠️ It is deliberately SYNCHRONOUS and awaits no `connection()`, because it touches no content —
 * it only says where content is. That is also what keeps its callers out of the `<Suspense>`
 * enclosure rule, which fires on awaiting a reader export rather than on importing one.
 */
// (the lint context below is NOT exported: nothing outside this module should be assembling one)

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
  const { projectRoot, contentRoot } = planningRoots();
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

  // ⚠️ TOTALS COME FROM THE PARSED SET FOR THIS REQUEST, and from nothing else — not from a
  // filename count, not from a cached summary, not from anything the view already displayed. A record
  // whose file failed to parse has `doc: null`, so it contributes to no total. AST-0035 measured the
  // skeleton reporting 178 while rendering 177 for exactly the opposite reason.
  const parsed = lint.records.filter((r) => r.doc);
  const counts = {};
  for (const r of parsed) counts[r.doc.type] = (counts[r.doc.type] ?? 0) + 1;

  // ⚠️ Every file that could NOT be parsed, with the position Node reports. Returned alongside the
  // totals rather than thrown, so a single bad file costs one artifact rather than the whole page.
  const unreadable = lint.records
    .filter((r) => !r.doc)
    .map((r) => {
      const m = /\(line (\d+) column (\d+)\)/.exec(r.parseError ?? "");
      return {
        path: `planning-content/${r.relPath}`,
        line: m ? Number(m[1]) : null,
        column: m ? Number(m[2]) : null,
        message: r.parseError ?? "could not be read",
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    contentRoot,
    stages,
    currentStage: stages.find((s) => !s.ready)?.id ?? null,
    counts,
    artifactCount: parsed.length,
    unreadable,
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
  const { projectRoot, contentRoot } = planningRoots();
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
  const { contentRoot } = planningRoots();
  const docs = readStageDocs(contentRoot);
  for (const [name, text] of docs) if (name.replace(/\.mdx?$/, "") === stageId) return { name, text };
  return null;
}

/**
 * The known stage ids, for validating a URL segment by EXACT MATCH.
 *
 * ⚠️ This exists so no caller ever builds a filesystem path out of a URL. A route segment is
 * compared against a set derived from the stage definitions; anything not in it is simply not a
 * stage. There is no sanitising step to get wrong, because nothing is ever concatenated.
 */
export async function readKnownStageIds() {
  await connection();
  const { projectRoot } = roots();
  return Object.keys(loadStageDefinitions(projectRoot) ?? {});
}

/**
 * One artifact's identity and review state, for the review panel.
 *
 * ⚠️ Read from the linted records rather than by opening a file named after the id — same reason as
 * above. An id that does not exist returns null; it never becomes a path.
 */
export async function readArtifactSummary(id) {
  await connection();
  const { projectRoot, contentRoot } = planningRoots();
  const { records } = lintProject(context(projectRoot, contentRoot));
  const doc = records.map((r) => r.doc).find((d) => d?.id === id);
  if (!doc) return null;
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title ?? "",
    reviewStatus: doc.reviewStatus ?? "draft",
    lifecycle: doc.lifecycle ?? "active",
  };
}
