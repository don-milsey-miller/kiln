/**
 * `QST-0010` — the typed operation for approving artifact type activation (#39).
 *
 * ⚠️ **It was the last authorised transition performed by hand-editing a file**, and it stayed
 * non-blocking only while no activation change was pending. Approving `component` (#140) made it an
 * immediate prerequisite: activating by hand once more would be the fifth instance of #126's pattern
 * — the workflow authorises a transition and supplies no operation for it — committed knowingly.
 *
 * ⚠️ **What it validates, and what it must NOT touch (#121's correction, #95).**
 * Project activation is **not** a catalogue change. This operation:
 *   - VALIDATES that the type exists in the catalogue (`common.schema.json`'s prefix table) and has
 *     a schema and a typed tool — activating a type nothing can author is #94's capability gap
 *     created on purpose;
 *   - VALIDATES that the stage definitions are compatible — some stage must produce the type, or
 *     activation makes it authorable and unreachable;
 *   - WRITES only `capabilities.artifactTypes.activated` in the project manifest.
 * It never edits `stages/`, `schemas/`, or #38's catalogue. A project-scoped approval that rewrote
 * the methodology would silently become a product-wide design change.
 *
 * ⚠️ **Deactivation is included and is NOT the reverse of activation.** Deactivating a type whose
 * artifacts exist would strand them, so it refuses while any live artifact of that type remains —
 * #107's deactivated-type silence, prevented rather than reported.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { withLock } from "../lock.mjs";
import { atomicWrite } from "../atomic-write.mjs";
import { resolveContentRoot } from "../content-root.mjs";
import { ValidationError } from "../validate.mjs";
import { loadSchemaSet, typePrefixes } from "../schema-resolver.mjs";
import { loadStageDefinitions } from "../stages.mjs";
import { readActivatedTypes } from "../activation.mjs";
import { TYPED_TOOLS } from "./registry.mjs";
import { artifactDir } from "../layout.mjs";
import { LOCK_FILE } from "./create-artifact.mjs";

const DEFAULT_SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

/**
 * @param {string} type
 * @param {"activate"|"deactivate"} action
 * @param {{contentRoot?: string, schemasDir?: string, stagesDir?: string, approvedBy?: string, reason?: string}} [opts]
 */
export async function setTypeActivation(type, action, opts = {}) {
  if (action !== "activate" && action !== "deactivate")
    throw new ValidationError(`action must be "activate" or "deactivate", got ${JSON.stringify(action)}.`, []);
  if (!opts.approvedBy)
    throw new ValidationError("Activation is a PM approval (#39) and must record who approved it.", []);

  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemas = loadSchemaSet(opts.schemasDir ?? DEFAULT_SCHEMAS);

  // --- catalogue membership: the type must EXIST before a project may activate it (#95)
  const prefixes = typePrefixes(schemas);
  if (!(type in prefixes))
    throw new ValidationError(
      `"${type}" is not in the catalogue. Adding a type edits common.schema.json's prefix table (#40) and is a ` +
        `CATALOGUE change; this operation only activates a type a project may already author.`,
      []
    );

  if (action === "activate") {
    // --- authorability: activating a type nothing can author is a capability gap made on purpose
    if (!schemas.types?.[type])
      throw new ValidationError(`"${type}" has no schema. Activating it would make it required and unauthorable (#94).`, []);
    if (!TYPED_TOOLS[type])
      throw new ValidationError(`"${type}" has no typed tool. #88 forbids authoring it any other way, so activation would strand it.`, []);

    // --- reachability: some stage must produce it, or it is authorable and never reached
    // ⚠️ `loadStageDefinitions` takes the TOOL ROOT and appends `stages/`, and returns null when the
    // set is absent. Both were got wrong first: passing a stages directory produced `<dir>/stages`,
    // and the null then crashed instead of refusing. A missing definition set must REFUSE — #90 makes
    // stages/ the authority on where a type is produced, and an absent authority cannot approve.
    const defs = loadStageDefinitions(opts.toolRoot);
    if (!defs)
      throw new ValidationError(
        `No stage definitions found. stages/ is the authority on where a type is produced (#90), and ` +
          `activation cannot be validated without it.`,
        []
      );
    const producers = Object.values(defs).filter((d) => (d.produces ?? []).includes(type)).map((d) => d.id);
    if (producers.length === 0)
      throw new ValidationError(
        `No stage produces "${type}". Activation would make it authorable and unreachable — the stage definitions ` +
          `own where a type is produced (#90), and this operation validates against them rather than editing them.`,
        []
      );
  }

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const manifestPath = join(contentRoot, "project.yaml");
    if (!existsSync(manifestPath)) throw new ValidationError(`No project.yaml in ${contentRoot}.`, []);

    const before = readActivatedTypes(contentRoot);
    const isActive = before.includes(type);

    if (action === "activate" && isActive) return { type, action, changed: false, activated: before, reason: "already activated" };
    if (action === "deactivate" && !isActive) return { type, action, changed: false, activated: before, reason: "already inactive" };

    if (action === "deactivate") {
      // ⚠️ Refuse while artifacts exist. #107 describes a deactivated type going silent; stranding
      // live artifacts behind a manifest edit is how that silence starts.
      const dir = join(contentRoot, artifactDir(type));
      const live = existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
      if (live.length)
        throw new ValidationError(
          `${live.length} ${type} artifact(s) exist. Deactivating would strand them behind a manifest edit. ` +
            `Retire them first (setLifecycle), then deactivate.`,
          []
        );
    }

    const after = action === "activate" ? [...before, type].sort() : before.filter((t) => t !== type);
    const text = readFileSync(manifestPath, "utf-8");
    const rewritten = rewriteActivated(text, after, { type, action, approvedBy: opts.approvedBy, reason: opts.reason });
    if (rewritten === text) throw new ValidationError("Could not locate `activated:` in project.yaml; refusing to guess where to write it.", []);

    await atomicWrite(manifestPath, rewritten);

    // Re-read through the ONE reader, so the result reports what the file now says rather than what
    // this function believes it wrote.
    const confirmed = readActivatedTypes(contentRoot);
    return { type, action, changed: true, activated: confirmed, approvedBy: opts.approvedBy };
  });
}

/** Rewrite only the `activated:` line, leaving every comment in the manifest untouched. */
function rewriteActivated(text, types, { type, action, approvedBy, reason }) {
  const line = `    activated: [${types.join(", ")}]`;
  const stamp =
    `    # ${action === "activate" ? "Activated" : "Deactivated"} \`${type}\` — approved by ${approvedBy}` +
    (reason ? `: ${reason}` : "") +
    `\n    # Written by lib/tools/activate-type.mjs (QST-0010). Do not hand-edit this list.`;
  const inline = /^\s*activated:\s*\[[^\]]*\]\s*$/m;
  if (inline.test(text)) return text.replace(inline, `${stamp}\n${line}`);
  const block = /^\s*activated:\s*(?:#[^\n]*)?\n(?:\s*-\s*[^\n]*\n?)+/m;
  if (block.test(text)) return text.replace(block, `${stamp}\n${line}\n`);
  return text;
}
