/**
 * Publish the handoff package.
 *
 * The order is the design, and every step of it is a refusal to trust something earlier:
 *
 *   lock  →  re-evaluate completeness  →  snapshot input  →  render to temp  →  validate temp
 *         →  atomically swap into place  →  release
 *
 * ⚠️ **Completeness is re-evaluated INSIDE the lock, immediately before the snapshot is taken.** A
 * gate result from an earlier command describes a repository that may have changed since — and the
 * window between "we checked" and "we published" is exactly where a half-finished edit gets frozen
 * into a package that claims to be approved.
 *
 * ⚠️ **The gate evaluation and the input snapshot happen under the SAME lock.** Evaluating under one
 * lock and reading under another would let a writer land between them, so the package would be
 * rendered from content the gate never saw.
 *
 * ⚠️ **A refusal or a rendering failure writes NOTHING**, and the previous package survives untouched.
 * A stale package is wrong in a way its own MANIFEST reveals; a half-replaced one is wrong in a way
 * nothing reveals.
 *
 * ⚠️ **The swap replaces the directory rather than merging into it**, which is what makes removed
 * source material disappear. Writing files over an existing package would leave a deleted
 * requirement's JSON sitting there forever, still readable, still wrong.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { withLock } from "../lock.mjs";
import { lintProject } from "../lint.mjs";
import { handoffCompleteness } from "./completeness.mjs";
import { renderPackage, hashFiles } from "./render.mjs";
import { LOCK_FILE } from "../tools/create-artifact.mjs";

export class HandoffRefused extends Error {
  constructor(message, blockers) {
    super(message);
    this.name = "HandoffRefused";
    this.blockers = blockers;
  }
}

/**
 * @param {object} ctx lint context: {contentRoot, schemas, validators, activated}
 * @param {{outDir: string, toolRoot?: string, toolVersion: string}} opts
 */
export async function publishHandoff(ctx, opts) {
  const { outDir, toolVersion } = opts;

  return withLock(join(ctx.contentRoot, LOCK_FILE), async () => {
    // 1. Re-evaluate NOW, inside the lock. Never a cached verdict.
    const completeness = handoffCompleteness(ctx, { toolRoot: opts.toolRoot });
    if (!completeness.ready)
      throw new HandoffRefused(
        `Refusing to publish: ${completeness.blockers.length} blocker(s). Nothing was written; the previous package is untouched.`,
        completeness.blockers
      );

    // 2. Snapshot the canonical input under the SAME lock the gate ran under.
    const { records } = lintProject(ctx);
    const stageDocs = readStageDocs(ctx.contentRoot);

    // 3. Render into a temporary package. If this throws, nothing has been touched yet.
    // ⚠️ `opts.render` exists so a test can FORCE a rendering failure. The alternative was to trust
    // that the "a failure preserves the previous package" path works because it looks like it should,
    // and an untested recovery path is a recovery path that has never recovered anything.
    const render = opts.render ?? renderPackage;
    const files = render({ records, activated: ctx.activated, toolVersion, stageDocs });

    const parent = dirname(outDir);
    mkdirSync(parent, { recursive: true });
    const temp = mkdtempSync(join(parent, ".handoff-tmp-"));
    try {
      for (const [rel, content] of files) {
        const dest = join(temp, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
      }

      // 4. Validate the rendered package before it replaces anything.
      const problems = [...validatePackage(temp, files), ...stageDocSetProblems(stageDocs, files)];
      if (problems.length) throw new HandoffRefused(`Rendered package failed validation: ${problems.join("; ")}`, problems.map((p) => ({ reason: "invalid-package", detail: p })));

      // 5. Swap. Move the old aside first so a failure can put it back.
      swapIntoPlace(temp, outDir, opts.rename);

      return { published: true, outDir, snapshot: JSON.parse(files.get("MANIFEST.json")).snapshot, fileCount: files.size, artifactCount: completeness.artifactCount };
    } finally {
      // The temp only survives if the swap never happened; either way it must not linger.
      if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    }
  });
}

/**
 * Replace `outDir` with `temp`, restoring the previous package if the second move fails.
 *
 * ⚠️ **Extracted so the recovery path can be REACHED.** Falsification found that deleting the restore
 * line broke no test: nothing could force the first rename to succeed and the second to fail, so the
 * branch that puts the old package back had never once put anything back. `rename` is injectable for
 * exactly that, and for nothing else.
 *
 * @param {(from: string, to: string) => void} [rename]
 */
export function swapIntoPlace(temp, outDir, rename = renameSync) {
  const backup = `${outDir}.previous-${process.pid}`;
  const hadPrevious = existsSync(outDir);
  if (hadPrevious) rename(outDir, backup);
  try {
    rename(temp, outDir);
  } catch (e) {
    // Put it back exactly as it was. A failed publish must leave NO trace, not a missing directory.
    if (hadPrevious) rename(backup, outDir);
    throw e;
  }
  if (hadPrevious) rmSync(backup, { recursive: true, force: true });
}

/**
 * Which extensions are stage documents. Declared rather than inlined, because the old inline
 * `.endsWith(".md")` was a silent filter: renaming a stage document to `.mdx` removed it from every
 * package and nothing said so (AST-0028).
 */
export const STAGE_DOC_EXTENSIONS = [".md", ".mdx"];

/**
 * Stage narratives ship as-is: they are authored planning content, not generated output.
 *
 * ⚠️ **Anything else in `stages/` is REFUSED, not skipped.** A filter that silently drops what it
 * does not recognise is how the narrative half of a plan goes missing from a package that still
 * validates — and the same principle the MDX contract runs on (reject, never strip) has to hold on
 * the way out or the guarantee only covers half the trip.
 *
 * ⚠️ **Dotfiles are the one exemption, and it is narrow on purpose.** `.gitkeep` is already there and
 * `.DS_Store` arrives uninvited; neither is authored content and refusing on them would be noise that
 * teaches people to widen the rule. The hazard this guards against is an AUTHORED DOCUMENT going
 * missing, and a leading dot is an unambiguous statement that a file is not one. Anything without a
 * dot has to be named.
 */
export function readStageDocs(contentRoot) {
  const dir = join(contentRoot, "stages");
  const out = new Map();
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  const unrecognised = entries.filter((f) => !STAGE_DOC_EXTENSIONS.some((ext) => f.endsWith(ext)));
  if (unrecognised.length)
    throw new HandoffRefused(
      `Refusing to publish: ${unrecognised.length} file(s) in planning-content/stages/ are not stage documents ` +
        `(${unrecognised.join(", ")}). Expected ${STAGE_DOC_EXTENSIONS.join(" or ")}. Publishing would have ` +
        `dropped them silently; remove them or give them a stage-document extension.`,
      unrecognised.map((f) => ({ reason: "unrecognised-stage-file", detail: f }))
    );
  for (const f of entries) out.set(f, readFileSync(join(dir, f), "utf-8"));
  return out;
}

/**
 * Every stage document on disk reached the package, and the package invented none.
 *
 * ⚠️ **Set equality, not a count.** A count agrees with itself the moment one document is dropped and
 * another is added, and it agrees trivially when both sides are computed from the same map. This
 * compares the SOURCE directory against what the renderer actually emitted, which is the only
 * comparison that can catch a document that never entered the pipeline.
 */
export function stageDocSetProblems(stageDocs, files) {
  const source = [...stageDocs.keys()].sort();
  const packaged = [...files.keys()].filter((f) => f.startsWith("docs/")).map((f) => f.slice("docs/".length)).sort();
  const missing = source.filter((n) => !packaged.includes(n));
  const invented = packaged.filter((n) => !source.includes(n));
  const problems = [];
  if (missing.length) problems.push(`stage documents missing from the package: ${missing.join(", ")}`);
  if (invented.length) problems.push(`package contains stage documents with no source: ${invented.join(", ")}`);
  return problems;
}

/**
 * Check the package on disk against what was meant to be written.
 *
 * ⚠️ Reads the FILES back rather than trusting the map it just wrote from. A validation that inspects
 * the same in-memory value the renderer produced cannot detect a write that silently truncated or a
 * path that collided — it only proves the renderer agrees with itself.
 */
export function validatePackage(root, files) {
  const problems = [];
  for (const [rel, expected] of files) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      problems.push(`${rel} was not written`);
      continue;
    }
    const actual = readFileSync(path, "utf-8");
    if (actual !== expected) problems.push(`${rel} differs from what was rendered`);
    if (rel.endsWith(".json")) {
      try {
        JSON.parse(actual);
      } catch (e) {
        problems.push(`${rel} is not valid JSON: ${e.message}`);
      }
    }
  }
  const onDisk = listFiles(root).sort();
  const extra = onDisk.filter((f) => !files.has(f));
  if (extra.length) problems.push(`unexpected files in the package: ${extra.join(", ")}`);
  return problems;
}

function listFiles(root, base = root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

export { hashFiles };
