/**
 * Adding the `## Intake` section to stage documents written before it existed — TSK-0060's migration.
 *
 * ⚠️ **WHY THIS EXISTS AT ALL.** `kiln_write_stage_document` writes into the `## Intake` section's two anchored
 * regions and REFUSES a document that does not have them, rather than upgrading one during a write: a write is
 * not the moment to restructure a document somebody may have edited. Projects initialized before that section
 * existed therefore cannot record an answer at all. Something has to add it, deliberately, and setup is the one
 * command that already holds the project's lock and a transaction.
 *
 * ⚠️ **IT ADDS, AND ONLY WHEN THE SECTION IS ABSENT.** A document whose heading is there is left alone, whatever
 * state its anchors are in: a renamed or reordered anchor is the operator's own edit, and the writer's refusal
 * already tells them what it cannot follow. Repairing one here would mean deciding which of their lines were
 * meant to be Kiln's.
 *
 * ⚠️ **AND IT APPENDS RATHER THAN PLACING.** The generator puts the section between `## Purpose` and `## Working
 * notes`; an older document may have neither, or may have them in another order, or may have prose where the
 * generator put a heading. Inserting "in the right place" means guessing at the shape of somebody's document,
 * while appending needs no guess and moves nothing they wrote. The section is found by heading, not by position,
 * so the writer does not care where it sits, and an operator who wants it higher can move it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { INTAKE_HEADING, intakeSection } from "./stage-documents.mjs";

/** Where stage documents live inside a content root. */
export const STAGE_DIR = "stages";

/** A whole line, never a substring: `## Intake notes` is a different heading, and prose mentioning it is prose. */
const hasIntake = (text) => text.split(/\r?\n/).some((line) => line.trimEnd() === INTAKE_HEADING);

/**
 * The line ending this document already uses, so a migration does not mix them.
 *
 * ⚠️ A document written on Windows and committed with CRLF stays CRLF: appending LF lines to it would show every
 * added line as changed in an editor that normalises, and would leave one file with two conventions.
 */
const endingOf = (text) => (/\r\n/.test(text) ? "\r\n" : "\n");

/**
 * What one document needs, without writing anything.
 *
 * @param {string} text  the document as it is now
 * @returns {{needed: false} | {needed: true, text: string}} the migrated bytes, when one is needed
 */
export function migrateIntakeSection(text) {
  if (hasIntake(text)) return { needed: false };

  const eol = endingOf(text);
  const body = text.replace(/\s+$/, "");
  const section = intakeSection().split("\n").join(eol);
  return { needed: true, text: `${body}${eol}${eol}${section}${eol}` };
}

/**
 * Which of a content root's stage documents need the section, read-only.
 *
 * ⚠️ **READ-ONLY, BECAUSE THE ANSWER DECIDES WHAT THE TRANSACTION PLANS.** A migration that discovered its targets
 * while writing them would plan nothing and write anyway, which is the shape of mutation this command exists to
 * avoid; asking first means the documents it will touch are contained, probed and identity-checked like every
 * other planned write.
 *
 * @param {string} contentRoot
 * @param {string[]} stageIds  the ids the stage definition set declares
 * @returns {Array<{id: string, path: string, text: string, migrated: string}>}
 */
export function pendingMigrations(contentRoot, stageIds) {
  const pending = [];
  for (const id of stageIds) {
    const path = join(contentRoot, STAGE_DIR, `${id}.md`);
    let text;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      // ⚠️ A DOCUMENT THAT IS NOT THERE IS NOT A MIGRATION. The initializer reports a missing stage document as
      // damage, with its own vocabulary and its own remedy; inventing one here would hide that.
      continue;
    }
    const result = migrateIntakeSection(text);
    if (result.needed) pending.push({ id, path, text, migrated: result.text });
  }
  return pending;
}
