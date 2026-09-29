/** Constrained typed artifact reads for agents. No caller supplies a filesystem path. */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { artifactAbsPath, artifactDir } from "../layout.mjs";
import { typeOfId } from "../schema-resolver.mjs";
import { canonicalPath, isAtOrInside } from "../content-root.mjs";

export const ARTIFACT_READ_TYPES_ENV = "KILN_ARTIFACT_READ_TYPES";
export const ARTIFACT_READ_LIMIT = Object.freeze({ DEFAULT: 20, MAX: 50 });

const ROLE_TYPES = Object.freeze({
  research: Object.freeze(["assertion", "decision", "evidence", "question", "requirement"]),
  planning: Object.freeze([
    "acceptance-criterion", "api-spec", "assertion", "component", "decision", "evidence", "question",
    "requirement", "runbook-step", "schema", "task", "wireframe",
  ]),
  validation: Object.freeze(["acceptance-criterion", "api-spec", "assertion", "component", "evidence", "schema"]),
});

export function artifactReadTypesForRole(role) {
  return ROLE_TYPES[role] ? [...ROLE_TYPES[role]] : [];
}

export class ArtifactReadRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArtifactReadRefusal";
    this.code = code;
  }
}

const refuse = (code, message) => { throw new ArtifactReadRefusal(code, message); };
// Group the digest so the model-facing credential scrubber does not mistake an ordinary 64-character
// hexadecimal checksum for a secret. The algorithm and all 256 bits remain explicit and stable.
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex").match(/.{1,8}/g).join("-")}`;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function permittedTypes(ctx, env) {
  const active = new Set(ctx.activated ?? []);
  const declared = env?.[ARTIFACT_READ_TYPES_ENV];
  if (typeof declared !== "string" || declared.length === 0) return active;
  return new Set(declared.split(",").filter((type) => active.has(type)));
}

function authorize(type, ctx, env) {
  if (!ctx.schemas?.types?.[type]) refuse("unknown-type", "That artifact type is not in this tool's schema catalogue.");
  if (!(ctx.activated ?? []).includes(type)) refuse("inactive-type", "That artifact type is not activated for this project.");
  if (!permittedTypes(ctx, env).has(type)) refuse("type-not-permitted", "This agent role is not permitted to read that artifact type.");
}

function readOne(type, id, ctx) {
  const path = artifactAbsPath(ctx.contentRoot, type, id);
  if (!existsSync(path)) refuse("unknown-id", "No artifact with that id exists in this project.");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !isAtOrInside(canonicalPath(path), canonicalPath(ctx.contentRoot)))
      refuse("artifact-path-refused", "The artifact is not a regular entry contained by this project's content root.");
  } catch (error) {
    if (error instanceof ArtifactReadRefusal) throw error;
    refuse("artifact-unreadable", "The artifact exists but its storage boundary could not be verified.");
  }
  let bytes;
  let artifact;
  try {
    bytes = readFileSync(path);
    artifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse("artifact-unreadable", "The artifact exists but could not be read as JSON.");
  }
  if (artifact?.id !== id || artifact?.type !== type || !ctx.validators?.[type]?.(artifact))
    refuse("artifact-invalid", "The stored artifact does not match its typed identity or schema.");
  return { artifact, hash: hash(bytes) };
}

function cursorFor(filter, after) {
  return Buffer.from(JSON.stringify({ v: 1, ...filter, after }), "utf8").toString("base64url");
}

function cursorAfter(cursor, filter) {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value?.v !== 1 || value.type !== filter.type || value.reviewStatus !== filter.reviewStatus || typeof value.after !== "string") throw new Error();
    return value.after;
  } catch {
    refuse("invalid-cursor", "That cursor does not belong to this artifact query.");
  }
}

export function listArtifacts(params, ctx, { env = process.env } = {}) {
  const type = params?.type;
  authorize(type, ctx, env);
  const reviewStatus = params?.reviewStatus ?? null;
  const limit = params?.limit ?? ARTIFACT_READ_LIMIT.DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_READ_LIMIT.MAX) refuse("invalid-limit", `limit must be between 1 and ${ARTIFACT_READ_LIMIT.MAX}.`);
  if (reviewStatus !== null && !["draft", "in-review", "approved", "amended"].includes(reviewStatus)) refuse("invalid-review-status", "That review status is not supported.");

  const filter = { type, reviewStatus };
  const after = cursorAfter(params?.cursor, filter);
  const dir = join(ctx.contentRoot, artifactDir(type));
  if (existsSync(dir)) {
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isAtOrInside(canonicalPath(dir), canonicalPath(ctx.contentRoot)))
        refuse("artifact-path-refused", "The artifact collection is not a regular directory contained by this project's content root.");
    } catch (error) {
      if (error instanceof ArtifactReadRefusal) throw error;
      refuse("artifact-unreadable", "The artifact collection's storage boundary could not be verified.");
    }
  }
  const ids = existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => basename(file, ".json"))
        .filter((id) => typeOfId(ctx.schemas, id) === type && (after === null || byCodeUnit(id, after) > 0))
        .sort(byCodeUnit)
    : [];

  const matches = [];
  for (const id of ids) {
    const record = readOne(type, id, ctx);
    if (reviewStatus !== null && record.artifact.reviewStatus !== reviewStatus) continue;
    matches.push(record);
    if (matches.length > limit) break;
  }
  const records = matches.slice(0, limit);
  const lastReturned = records.at(-1)?.artifact.id ?? null;
  return {
    ok: true,
    type,
    reviewStatus,
    records,
    nextCursor: matches.length > limit ? cursorFor(filter, lastReturned) : null,
  };
}

export function readArtifact(params, ctx, { env = process.env } = {}) {
  const id = params?.id;
  const type = typeof id === "string" ? typeOfId(ctx.schemas, id) : null;
  if (type === null) refuse("unknown-id", "That id does not identify a known artifact type.");
  authorize(type, ctx, env);
  return { ok: true, type, ...readOne(type, id, ctx) };
}
