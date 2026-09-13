/**
 * What `kiln_project_status` reads about a project beyond handoff readiness — TSK-0048 (G3a), toward ACC-0068.
 *
 * ⚠️ **THIS MODULE READS; THE PACKAGE BOUNDARY SANITISES.** It returns the derived orchestration state (G2),
 * the project's name and description, and the Stage 1 document exactly as the project holds them. Every one
 * of those is project-authored and untrusted. `pi-package/extensions/kiln.js` reduces paths, cleans every
 * string and caps the document before any of it reaches a model.
 *
 * ⚠️ **A FAILURE BECOMES AN AUTHORED REFUSAL, NEVER A CLEANED ERROR (F101).** Loader errors quote absolute
 * paths and parse excerpts of the file they failed on. Every failure here is turned into a stable code with
 * a message written in this file; the original error survives only as the refusal's `cause`, for a caller
 * that is not a model.
 *
 * ⚠️ **NO YAML PARSER (D18).** `project.yaml`'s `name` and `description` are read in two shapes only: the exact
 * double-quoted form the scaffold writes with `yamlString`, and a conservative one-line plain scalar. Anything
 * else - folded, literal, multi-line, tagged, single-quoted, typed, duplicated or otherwise ambiguous - is
 * reported unreadable rather than guessed at.
 */

import { readFileSync } from "node:fs";

import { resolveInContentRoot } from "./content-root.mjs";
import { OrchestratorStateError, ORCHESTRATOR_STATE_REFUSAL, deriveOrchestratorState } from "./orchestrator-state.mjs";
import { byCodeUnit } from "./project-scaffold.mjs";
import { StageDefinitionError, loadStageDefinitions } from "./stages.mjs";

export const PROJECT_STATUS_REFUSAL = Object.freeze({
  STAGE_DEFINITIONS_MISSING: ORCHESTRATOR_STATE_REFUSAL.NO_DEFINITIONS,
  STAGE_DEFINITIONS_UNREADABLE: "stage-definitions-unreadable",
  STAGE_NOT_READY_WITHOUT_FINDING: ORCHESTRATOR_STATE_REFUSAL.UNEXPLAINED_GATE,
  PROJECT_STATE_UNREADABLE: "project-state-unreadable",
  STAGE_DOCUMENT_MISSING: "stage-document-missing",
  STAGE_DOCUMENT_UNREADABLE: "stage-document-unreadable",
});

/** The only messages a refusal from this module can carry. None of them quotes anything it read. */
export const PROJECT_STATUS_MESSAGES = Object.freeze({
  [PROJECT_STATUS_REFUSAL.STAGE_DEFINITIONS_MISSING]: "No stage definitions were found, so the project's current stage cannot be derived.",
  [PROJECT_STATUS_REFUSAL.STAGE_DEFINITIONS_UNREADABLE]: "The stage definitions could not be read, so the project's current stage cannot be derived.",
  [PROJECT_STATUS_REFUSAL.STAGE_NOT_READY_WITHOUT_FINDING]: "A stage is not ready and its gate reports no finding, so no next action can be chosen.",
  [PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE]: "The project's planning state could not be read, so its status cannot be reported.",
  [PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_MISSING]: "The Stage 1 document does not exist in the project's stages directory, so it cannot be supplied.",
  [PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_UNREADABLE]: "The Stage 1 document could not be read inside the project's content root, so it cannot be supplied.",
});

/** Reported per field when `name` or `description` cannot be read in a supported shape. */
export const PROJECT_IDENTITY_UNREADABLE = "project-identity-unreadable";

export class ProjectStatusRefusal extends Error {
  constructor(code, { cause } = {}) {
    super(PROJECT_STATUS_MESSAGES[code] ?? PROJECT_STATUS_MESSAGES[PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE], cause === undefined ? undefined : { cause });
    this.name = "ProjectStatusRefusal";
    this.code = code in PROJECT_STATUS_MESSAGES ? code : PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE;
  }
}

/** Any failure, as an authored refusal. The error is kept as `cause` and contributes nothing else. */
export function toProjectStatusRefusal(error) {
  if (error instanceof ProjectStatusRefusal) return error;
  if (error instanceof OrchestratorStateError)
    return new ProjectStatusRefusal(error.reason in PROJECT_STATUS_MESSAGES ? error.reason : PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE, { cause: error });
  if (error instanceof StageDefinitionError || error instanceof SyntaxError)
    return new ProjectStatusRefusal(PROJECT_STATUS_REFUSAL.STAGE_DEFINITIONS_UNREADABLE, { cause: error });
  return new ProjectStatusRefusal(PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE, { cause: error });
}

/* ============================================================================ project identity (D18) */

/** Exactly the escapes `yamlString` writes, and no others. */
const YAML_ESCAPES = Object.freeze({ '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t" });
const isControl = (code) => code < 0x20 || code === 0x7f;

/** A one-line double-quoted scalar in the scaffold's form, or null. */
function parseDoubleQuoted(raw) {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= raw.length) return null; // unterminated on this line: multi-line or malformed
    const ch = raw[i];
    if (ch === '"') break;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === "x") {
        const hex = raw.slice(i + 2, i + 4);
        if (!/^[0-9a-f]{2}$/.test(hex)) return null;
        const code = Number.parseInt(hex, 16);
        if (!isControl(code)) return null; // `yamlString` escapes only control characters this way
        out += String.fromCharCode(code);
        i += 4;
        continue;
      }
      if (typeof next === "string" && Object.hasOwn(YAML_ESCAPES, next)) {
        out += YAML_ESCAPES[next];
        i += 2;
        continue;
      }
      return null;
    }
    if (isControl(ch.charCodeAt(0))) return null;
    out += ch;
    i += 1;
  }
  // After the closing quote: nothing, or whitespace and a comment.
  return /^(?:\s+#.*|\s*)$/.test(raw.slice(i + 1)) ? out : null;
}

const PLAIN_START_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;
const YAML_NON_STRING = /^(?:~|null|true|false|yes|no|on|off|y|n)$/i;
const YAML_NUMBER = /^[-+]?(?:\.inf|\.nan|0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:e[-+]?\d+)?)$/i;

/** A conservative one-line plain scalar that YAML would read as this exact string, or null. */
function parsePlain(raw) {
  const value = raw.trim();
  if (value.length === 0) return null; // YAML null
  if (PLAIN_START_INDICATOR.test(value)) return null; // quoted, tagged, block, anchor, alias, flow, directive
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/:\s|:$|\s#/.test(value)) return null; // a nested mapping or a comment would change what it means
  if (YAML_NON_STRING.test(value) || YAML_NUMBER.test(value)) return null; // YAML would not read a string
  return value;
}

function readTopLevelScalar(lines, field) {
  const prefix = `${field}:`;
  const at = [];
  lines.forEach((line, index) => {
    if (line.startsWith(prefix)) at.push(index);
  });
  if (at.length !== 1) return null; // absent, or declared more than once

  const index = at[0];
  const rest = lines[index].slice(prefix.length);
  if (rest.length > 0 && !rest.startsWith(" ")) return null;

  // An indented, non-comment line after it would continue or nest this value.
  const next = lines[index + 1];
  if (next !== undefined && /^[ \t]+\S/.test(next) && !/^[ \t]+#/.test(next)) return null;

  const raw = rest.trimStart();
  return raw.startsWith('"') ? parseDoubleQuoted(raw) : parsePlain(raw);
}

/**
 * The project's name and description, each either read or reported unreadable.
 *
 * @param {string} contentRoot
 * @returns {{name: string|null, description: string|null, issues: Array<{field: string, code: string}>}}
 */
export function readProjectIdentity(contentRoot) {
  let lines = null;
  try {
    lines = readFileSync(resolveInContentRoot("project.yaml", { contentRoot }), "utf8").split(/\r?\n/);
  } catch {
    lines = null; // absent, unreadable or outside the root: every field is unreadable, and nothing is guessed
  }

  const identity = { name: null, description: null, issues: [] };
  for (const field of ["name", "description"]) {
    const value = lines === null ? null : readTopLevelScalar(lines, field);
    if (value === null) identity.issues.push({ field, code: PROJECT_IDENTITY_UNREADABLE });
    else identity[field] = value;
  }
  return identity;
}

/* ============================================================================ the Stage 1 document (D19) */

/**
 * A stage's document, read inside the content root.
 *
 * ⚠️ **A LINK OUT OF THE ROOT IS REFUSED, NOT FOLLOWED.** The text is handed to a model; a `stages/` that
 * pointed somewhere else would hand it whatever file lived there.
 *
 * @returns {{stageId: string, path: string, text: string}}
 */
export function readStageDocument(contentRoot, stageId) {
  const path = `stages/${stageId}.md`;
  let absolute;
  try {
    absolute = resolveInContentRoot(path, { contentRoot });
  } catch (cause) {
    throw new ProjectStatusRefusal(PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_UNREADABLE, { cause });
  }

  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (cause) {
    const missing = cause?.code === "ENOENT" || cause?.code === "ENOTDIR";
    throw new ProjectStatusRefusal(missing ? PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_MISSING : PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_UNREADABLE, { cause });
  }
  return { stageId, path, text };
}

/* ============================================================================ the whole read */

/**
 * The orchestration state, the project's identity and the Stage 1 document, from one definition load.
 * Throws `ProjectStatusRefusal` for every failure.
 *
 * @param {{contentRoot: string, schemas: object, validators: object, activated: string[]}} ctx
 * @param {{toolRoot?: string}} [opts]
 */
export function readProjectStatus(ctx, opts = {}) {
  try {
    const defs = loadStageDefinitions(opts.toolRoot);
    const orchestration = deriveOrchestratorState(ctx, { stageDefinitions: defs });
    const firstStage = Object.keys(defs).sort(byCodeUnit)[0];
    return {
      orchestration,
      project: readProjectIdentity(ctx.contentRoot),
      stageOneDocument: readStageDocument(ctx.contentRoot, firstStage),
    };
  } catch (error) {
    throw toProjectStatusRefusal(error);
  }
}
