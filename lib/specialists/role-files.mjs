/**
 * What `specialists/` holds, against what the contract and the prose call for — TSK-0051 (S12).
 *
 * ⚠️ **ONE PLAN, BOTH MODES.** The check and the write call this, so a check cannot compare against
 * output the write would not produce. That is the same arrangement `lib/stage-skills-files.mjs` makes,
 * and for the same reason: two descriptions of "current" drift, and the one that drifts is the guard.
 *
 * ⚠️ **THE GENERATOR OWNS `specialists/<role>.md` AND NOTHING ELSE.** A file there for a role that does
 * not exist is reported as orphaned; whether it may be REMOVED depends on whether it is one of ours,
 * decided by the generated notice inside its frontmatter and by nothing else.
 *
 * ⚠️ **READS ONLY.** Planning never writes, which is what lets `--check` promise it changed nothing.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "../atomic-write.mjs";
import { canonicalPath, isAtOrInside } from "../content-root.mjs";
import { byCodeUnit } from "../project-scaffold.mjs";
import { ROLES, contractFor } from "./contract.mjs";
import { RoleParseRefusal, parseRoleDefinition } from "./parse.mjs";
import { GENERATED_NOTICE, RoleRenderRefusal, SECTIONS, SPECIALISTS_DIR, renderRole } from "./render.mjs";

export const DRIFT = Object.freeze({ STALE: "stale", MISSING: "missing", ORPHANED: "orphaned" });

export const SYNC_REFUSAL = Object.freeze({
  RENDER: "role-cannot-be-rendered",
  NO_DIRECTORY: "specialists-directory-missing",
  NOT_A_DIRECTORY: "specialists-not-a-directory",
  LINKED_ENTRY: "linked-entry",
  UNOWNED_CONTENT: "unowned-content",
  PATH_ESCAPE: "path-escapes-specialists-directory",
  TOOLS_MISMATCH: "tools-do-not-match-contract",
  SECTIONS_MISMATCH: "sections-do-not-match",
  IDENTITY_MISMATCH: "identity-does-not-match-role",
  IO: "io-error",
  UNVERIFIED: "write-not-verified",
});

const DRIFT_ORDER = [DRIFT.STALE, DRIFT.MISSING, DRIFT.ORPHANED];
const shown = (name) => `${SPECIALISTS_DIR}/${name}`;
const refusal = (code, message, role = null) => ({ code, message, role });
const ioRefusal = (error, where, role = null) =>
  refusal(SYNC_REFUSAL.IO, `${where} could not be read or written (${error?.code ?? error?.name ?? "unknown error"}).`, role);
const byRoleThenKind = (a, b) =>
  byCodeUnit(a.role ?? "", b.role ?? "") || DRIFT_ORDER.indexOf(a.kind) - DRIFT_ORDER.indexOf(b.kind) || byCodeUnit(a.code ?? "", b.code ?? "");

/**
 * What the contract calls for, compared with what the directory holds. Reads only.
 *
 * @param {string} toolRoot
 */
export function planRoleDefinitions(toolRoot) {
  const root = canonicalPath(toolRoot);
  const dir = join(root, SPECIALISTS_DIR);
  const drift = [];
  const refusals = [];

  // ---- what the contract and the prose call for
  const wanted = [];
  for (const role of ROLES) {
    try {
      wanted.push({ role, file: `${role}.md`, content: renderRole(role) });
    } catch (error) {
      if (!(error instanceof RoleRenderRefusal)) throw error;
      refusals.push(refusal(SYNC_REFUSAL.RENDER, `${role} cannot be rendered: ${error.message}`, role));
    }
  }
  if (refusals.length) return { definitions: wanted, drift, refusals: refusals.sort(byRoleThenKind) };

  // ---- what the directory holds
  if (!existsSync(dir)) {
    for (const item of wanted) drift.push({ kind: DRIFT.MISSING, role: item.role, path: shown(item.file) });
    refusals.push(refusal(SYNC_REFUSAL.NO_DIRECTORY, `${SPECIALISTS_DIR}/ does not exist.`));
    return { definitions: wanted, drift, refusals };
  }
  let entries;
  try {
    if (!lstatSync(dir).isDirectory()) {
      refusals.push(refusal(SYNC_REFUSAL.NOT_A_DIRECTORY, `${SPECIALISTS_DIR} is not a directory.`));
      return { definitions: wanted, drift, refusals };
    }
    entries = readdirSync(dir).sort(byCodeUnit);
  } catch (error) {
    refusals.push(ioRefusal(error, `${SPECIALISTS_DIR}/`));
    return { definitions: wanted, drift, refusals };
  }

  const expected = new Set(wanted.map((w) => w.file));
  for (const name of entries) {
    if (expected.has(name)) continue;
    // ⚠️ OWNERSHIP DECIDED BY THE NOTICE, NOT THE NAME. A file somebody put here by hand is reported and
    // never removed.
    let owned = false;
    try {
      const full = join(dir, name);
      owned = lstatSync(full).isFile() && readFileSync(full, "utf8").split("\n", 2)[1] === GENERATED_NOTICE;
    } catch {
      owned = false;
    }
    drift.push({ kind: DRIFT.ORPHANED, role: name.replace(/\.md$/, ""), path: shown(name), owned });
  }

  for (const item of wanted) {
    const full = join(dir, item.file);

    // ⚠️ THE FILE MUST SIT WHERE IT APPEARS TO. A symlink here would make the write land outside the
    // directory the check reasoned about.
    if (!isAtOrInside(canonicalPath(full), canonicalPath(dir))) {
      refusals.push(refusal(SYNC_REFUSAL.PATH_ESCAPE, `${shown(item.file)} resolves outside ${SPECIALISTS_DIR}/.`, item.role));
      continue;
    }
    if (!existsSync(full)) {
      drift.push({ kind: DRIFT.MISSING, role: item.role, path: shown(item.file) });
      continue;
    }
    let stat;
    try {
      stat = lstatSync(full);
    } catch (error) {
      refusals.push(ioRefusal(error, shown(item.file), item.role));
      continue;
    }
    if (stat.isSymbolicLink()) {
      refusals.push(refusal(SYNC_REFUSAL.LINKED_ENTRY, `${shown(item.file)} is a link; it is not read, changed or removed.`, item.role));
      continue;
    }
    if (!stat.isFile()) {
      refusals.push(refusal(SYNC_REFUSAL.UNOWNED_CONTENT, `${shown(item.file)} is not a file.`, item.role));
      continue;
    }

    let found;
    try {
      found = readFileSync(full, "utf8");
    } catch (error) {
      refusals.push(ioRefusal(error, shown(item.file), item.role));
      continue;
    }

    // ---- the structural checks, stated separately from byte equality on purpose.
    //
    // ⚠️ BYTE EQUALITY WOULD CATCH ALL OF THESE. A criterion that says "an empty tool declaration fails
    // the check" deserves a failure that says so, not one that says "this file differs from the
    // generated one" and leaves an operator to work out which part.
    let read = null;
    try {
      read = parseRoleDefinition(found);
    } catch (error) {
      if (!(error instanceof RoleParseRefusal)) throw error;
      refusals.push(refusal(error.code, `${shown(item.file)} line ${error.line ?? "?"}: ${error.message}`, item.role));
    }

    if (read) {
      const contract = contractFor(item.role);
      if (read.role !== item.role || read.name !== `kiln-specialist-${item.role}`)
        refusals.push(refusal(SYNC_REFUSAL.IDENTITY_MISMATCH, `${shown(item.file)} declares name ${JSON.stringify(read.name)} and role ${JSON.stringify(read.role)}.`, item.role));
      if (read.tools.join("\n") !== contract.tools.join("\n"))
        refusals.push(
          refusal(
            SYNC_REFUSAL.TOOLS_MISMATCH,
            `${shown(item.file)} declares [${read.tools.join(", ")}]; the contract derives [${contract.tools.join(", ")}].`,
            item.role
          )
        );
      const want = SECTIONS.map((s) => s.heading);
      if (read.sections.join("\n") !== want.join("\n"))
        refusals.push(refusal(SYNC_REFUSAL.SECTIONS_MISMATCH, `${shown(item.file)} has sections [${read.sections.join(", ")}]; expected [${want.join(", ")}].`, item.role));
    }

    if (found !== item.content) drift.push({ kind: DRIFT.STALE, role: item.role, path: shown(item.file) });
  }

  return { definitions: wanted, drift: drift.sort(byRoleThenKind), refusals: refusals.sort(byRoleThenKind) };
}

/** The check: the plan, reported, with nothing written. */
export function checkRoleDefinitions(toolRoot) {
  const plan = planRoleDefinitions(toolRoot);
  const status = plan.refusals.length > 0 ? "refused" : plan.drift.length > 0 ? "drift" : "clean";
  return { status, drift: plan.drift, refusals: plan.refusals, expected: plan.definitions.length };
}

/** The write: create what is missing, replace what is stale, remove an orphan this generator owns. */
export async function writeRoleDefinitions(toolRoot, { plan: planWith = planRoleDefinitions } = {}) {
  const root = canonicalPath(toolRoot);
  const dir = join(root, SPECIALISTS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const plan = planWith(toolRoot);
  const refusals = plan.refusals.filter((r) => r.code !== SYNC_REFUSAL.NO_DIRECTORY);

  for (const item of plan.drift)
    if (item.kind === DRIFT.ORPHANED && !item.owned)
      refusals.push(refusal(SYNC_REFUSAL.UNOWNED_CONTENT, `${item.path} is orphaned but was not written by this generator; it is not removed.`, item.role));

  if (refusals.length > 0) return { status: "refused", changes: [], refusals: refusals.sort(byRoleThenKind), expected: plan.definitions.length };

  const changes = [];
  for (const item of plan.drift) {
    if (item.kind === DRIFT.ORPHANED) {
      try {
        unlinkSync(join(dir, `${item.role}.md`));
        changes.push({ kind: "removed", role: item.role, path: item.path });
      } catch (error) {
        return { status: "refused", changes, refusals: [ioRefusal(error, item.path, item.role)], expected: plan.definitions.length };
      }
      continue;
    }
    const definition = plan.definitions.find((d) => d.role === item.role);
    try {
      await atomicWrite(join(dir, definition.file), definition.content);
    } catch (error) {
      return { status: "refused", changes, refusals: [ioRefusal(error, item.path, item.role)], expected: plan.definitions.length };
    }
    changes.push({ kind: item.kind === DRIFT.MISSING ? "created" : "updated", role: item.role, path: item.path });
  }

  // ⚠️ THE WRITE IS VERIFIED BY RE-PLANNING. A write that reported success while leaving the directory
  // stale is the failure this guard exists to prevent.
  // ⚠️ RE-PLANNED THROUGH THE SAME SEAM, so a test can make the second plan disagree and prove this
  // branch reports rather than claiming success. It is unreachable single-threaded otherwise: the
  // renderer is deterministic and the write writes exactly what it planned.
  const after = planWith(toolRoot);
  if (after.drift.length > 0 || after.refusals.length > 0)
    return {
      status: "refused",
      changes,
      refusals: [refusal(SYNC_REFUSAL.UNVERIFIED, "The directory still differs after writing."), ...after.refusals].sort(byRoleThenKind),
      expected: plan.definitions.length,
    };

  return { status: "written", changes, refusals: [], expected: plan.definitions.length };
}

export { SPECIALISTS_DIR };
