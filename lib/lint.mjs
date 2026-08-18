/**
 * #46 / #47 — the lint. One implementation, three callers (`npm run lint:plan`, the app on
 * save, a Pi extension hook at turn end).
 *
 * The layering is strict, and each layer answers a different question:
 *
 *   Ajv (validate.mjs)        is this legal JSON for this artifact type?
 *   #84 (schema-resolver.mjs) what does this field MEAN?
 *   these rules               is this acceptable in the planning system?
 *
 * No rule reads a raw schema file. Everything needing schema metadata goes through #84, or
 * the lint slowly grows a second composition model — which is #47's own failure one level in.
 *
 * Rules also do NOT restate what the schema already enforces. The schema owns legality; the
 * lint owns everything the schema cannot see: filenames, directories, other files, and the
 * collection as a whole.
 *
 * ⚠️ Findings are DATA. No caller parses prose. The CLI renders one way, the app another, and
 * the Pi hook feeds the same object back to the agent (#48).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { effectiveSchema, typeOfId, typePrefixes } from "./schema-resolver.mjs";
import { artifactDir, parseArtifactRelPath, DATA_DIR } from "./layout.mjs";
import { formatErrors } from "./validate.mjs";

/** error blocks a gate · warning is reported continuously · advisory is expected-for-now (#75). */
export const SEVERITY = { ERROR: "error", WARNING: "warning", ADVISORY: "advisory" };

/** A finding, in the one shape every caller consumes. */
function finding(ruleId, severity, { artifactId = null, path = null, message, details = {} }) {
  return { ruleId, severity, artifactId, path, message, details };
}

const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX|LOREM IPSUM|<placeholder>)\b/i;

/* ------------------------------------------------------------------ loading */

/** Enumerate stored artifacts. Returns raw records — reading is not judging. */
export function loadArtifacts(ctx) {
  const out = [];
  const dataDir = join(ctx.contentRoot, DATA_DIR);
  if (!existsSync(dataDir)) return out;

  for (const dir of readdirSync(dataDir)) {
    const abs = join(dataDir, dir);
    if (!statSync(abs).isDirectory()) continue;
    for (const file of readdirSync(abs)) {
      if (!file.endsWith(".json")) continue;
      const relPath = `${DATA_DIR}/${dir}/${file}`;
      let doc = null;
      let parseError = null;
      try {
        doc = JSON.parse(readFileSync(join(abs, file), "utf-8"));
      } catch (e) {
        parseError = e.message;
      }
      out.push({ relPath, doc, parseError, ...parseArtifactRelPath(relPath) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ rules */

/** Family 1 — storage identity. Only the lint can see any of this (#87). */
function storageIdentity(ctx, rec) {
  const f = [];
  const { doc, relPath, dirType, filenameId } = rec;
  if (!doc) return f;

  if (dirType === null)
    return [
      finding("storage/unrecognised-path", SEVERITY.ERROR, {
        path: relPath,
        message: `File is not at data/<type>s/<ID>.json, so nothing can tell what it claims to be.`,
        details: { expected: "data/<type>s/<ID>.json" },
      }),
    ];

  if (doc.type !== dirType)
    f.push(
      finding("storage/type-mismatch-directory", SEVERITY.ERROR, {
        artifactId: doc.id ?? null,
        path: relPath,
        message: `Artifact declares type "${doc.type}" but lives in ${artifactDir(dirType)}.`,
        details: { declaredType: doc.type, directoryType: dirType },
      })
    );

  if (doc.id !== filenameId)
    f.push(
      finding("storage/id-mismatch-filename", SEVERITY.ERROR, {
        artifactId: doc.id ?? null,
        path: relPath,
        message: `Artifact id "${doc.id}" does not match its filename "${filenameId}.json".`,
        details: { id: doc.id, filenameId },
      })
    );

  const expectedType = typeOfId(ctx.schemas, doc.id ?? "");
  if (doc.id && expectedType && doc.type && expectedType !== doc.type)
    f.push(
      finding("storage/prefix-mismatch-type", SEVERITY.ERROR, {
        artifactId: doc.id,
        path: relPath,
        message: `ID prefix implies type "${expectedType}" but the artifact declares "${doc.type}".`,
        details: { idImplies: expectedType, declaredType: doc.type },
      })
    );

  return f;
}

/** Family 2 — trace integrity. Needs the whole collection, so no schema can express it. */
function traceIntegrity(ctx, rec, index) {
  const f = [];
  const { doc, relPath } = rec;
  if (!doc?.type || !ctx.schemas.types[doc.type]) return f;

  const eff = effectiveSchema(ctx.schemas, doc.type);
  const prefixes = typePrefixes(ctx.schemas);

  for (const [field, prop] of Object.entries(eff.properties)) {
    const targets = prop["x-traceTarget"];
    if (!targets) continue;
    for (const ref of doc[field] ?? []) {
      const refType = typeOfId(ctx.schemas, ref);

      if (!refType) {
        f.push(
          finding("trace/unknown-prefix", SEVERITY.ERROR, {
            artifactId: doc.id,
            path: relPath,
            message: `${field} references "${ref}", whose prefix is not in the artifact catalogue (#38).`,
            details: { field, ref, knownPrefixes: Object.values(prefixes) },
          })
        );
        continue;
      }

      if (!targets.includes(refType)) {
        f.push(
          finding("trace/wrong-target-type", SEVERITY.ERROR, {
            artifactId: doc.id,
            path: relPath,
            message: `${field} may point at ${targets.join(", ")} but "${ref}" is a ${refType}.`,
            details: { field, ref, refType, allowed: targets },
          })
        );
        continue;
      }

      if (!ctx.activated.includes(refType)) {
        // #75 in force: permitted, and expected to dangle until the type is activated.
        f.push(
          finding("trace/target-not-activated", SEVERITY.ADVISORY, {
            artifactId: doc.id,
            path: relPath,
            message: `${field} → ${ref}: "${refType}" is not activated on this project, so the link cannot resolve yet.`,
            details: { field, ref, refType },
          })
        );
        continue;
      }

      if (!index.has(ref))
        f.push(
          finding("trace/target-missing", SEVERITY.ERROR, {
            artifactId: doc.id,
            path: relPath,
            message: `${field} → ${ref}: "${refType}" is activated but no such artifact exists.`,
            details: { field, ref, refType },
          })
        );
    }
  }
  return f;
}

/** Family 3 — content completeness. Only what the schema cannot express. */
function contentCompleteness(ctx, rec) {
  const f = [];
  const { doc, relPath } = rec;
  if (!doc?.type || !ctx.schemas.types[doc.type]) return f;
  const eff = effectiveSchema(ctx.schemas, doc.type);

  for (const [field, prop] of Object.entries(eff.properties)) {
    const v = doc[field];

    // Whitespace-only. JSON Schema's minLength counts characters, including spaces.
    if (typeof v === "string" && v.length > 0 && v.trim().length === 0)
      f.push(
        finding("content/hollow-value", SEVERITY.ERROR, {
          artifactId: doc.id,
          path: relPath,
          message: `${field} contains only whitespace, which minLength cannot catch.`,
          details: { field },
        })
      );

    if (typeof v === "string" && PLACEHOLDER.test(v))
      f.push(
        finding("content/placeholder-marker", SEVERITY.WARNING, {
          artifactId: doc.id,
          path: relPath,
          message: `${field} still contains a placeholder marker.`,
          details: { field, excerpt: v.slice(0, 120) },
        })
      );

    // #45: the schema requires a reason; it cannot require the reason to say anything.
    if (v && typeof v === "object" && v.na === true && typeof v.reason === "string" && v.reason.trim().length < 10)
      f.push(
        finding("content/thin-na-reason", SEVERITY.WARNING, {
          artifactId: doc.id,
          path: relPath,
          message: `${field} is n/a with a reason too short to be a reason.`,
          details: { field, reason: v.reason },
        })
      );
  }
  return f;
}

/** Family 4 — lifecycle consistency ACROSS files. The schema owns the within-file invariants. */
function lifecycleConsistency(ctx, rec, byId) {
  const f = [];
  const { doc, relPath } = rec;
  if (!doc?.type || !ctx.schemas.types[doc.type]) return f;
  if (doc.lifecycle !== "active") return f;

  const eff = effectiveSchema(ctx.schemas, doc.type);
  for (const [field, prop] of Object.entries(eff.properties)) {
    if (!prop["x-traceTarget"]) continue;
    for (const ref of doc[field] ?? []) {
      const target = byId.get(ref);
      if (target && target.doc?.lifecycle && target.doc.lifecycle !== "active")
        f.push(
          finding("lifecycle/trace-to-inactive", SEVERITY.WARNING, {
            artifactId: doc.id,
            path: relPath,
            message: `${field} → ${ref}, which is ${target.doc.lifecycle}. An active artifact resting on one that no longer stands.`,
            details: { field, ref, targetLifecycle: target.doc.lifecycle },
          })
        );
    }
  }
  return f;
}

/* ------------------------------------------------------------------ entry points */

/**
 * @param {{contentRoot: string, schemas: object, validators: object, activated: string[]}} ctx
 */
export function lintArtifact(ctx, rec, opts = {}) {
  const f = [];
  const byId = opts.byId ?? new Map();
  const index = opts.index ?? new Set();

  if (rec.parseError)
    return [
      finding("artifact/unparseable", SEVERITY.ERROR, {
        path: rec.relPath,
        message: `File is not valid JSON: ${rec.parseError}`,
        details: {},
      }),
    ];

  const type = rec.doc?.type;
  if (!type || !ctx.validators[type]) {
    f.push(
      finding("artifact/unknown-type", SEVERITY.ERROR, {
        artifactId: rec.doc?.id ?? null,
        path: rec.relPath,
        message: `Artifact declares type ${JSON.stringify(type)}, which is not an activated schema.`,
        details: { type, known: Object.keys(ctx.validators) },
      })
    );
  } else if (!ctx.validators[type](rec.doc)) {
    // Layer 1: schema-invalid. The typed tool would have prevented this; it arrived another way.
    f.push(
      finding("schema/invalid", SEVERITY.ERROR, {
        artifactId: rec.doc.id ?? null,
        path: rec.relPath,
        message: `Does not satisfy ${type}.schema.json: ${formatErrors(ctx.validators[type].errors)}`,
        details: { errors: ctx.validators[type].errors },
      })
    );
  }

  f.push(...storageIdentity(ctx, rec));
  f.push(...contentCompleteness(ctx, rec));
  f.push(...traceIntegrity(ctx, rec, index));
  f.push(...lifecycleConsistency(ctx, rec, byId));
  return f;
}

/** Lint every stored artifact. Collection-level rules live here because they need the set. */
export function lintProject(ctx) {
  const records = loadArtifacts(ctx);
  const byId = new Map(records.filter((r) => r.doc?.id).map((r) => [r.doc.id, r]));
  const index = new Set(byId.keys());

  const findings = [];
  const seen = new Map();
  for (const rec of records) {
    findings.push(...lintArtifact(ctx, rec, { byId, index }));
    const id = rec.doc?.id;
    if (!id) continue;
    if (seen.has(id))
      findings.push(
        finding("storage/duplicate-id", SEVERITY.ERROR, {
          artifactId: id,
          path: rec.relPath,
          message: `${id} is also stored at ${seen.get(id)}. IDs are allocated once and never reused (#83).`,
          details: { otherPath: seen.get(id) },
        })
      );
    else seen.set(id, rec.relPath);
  }
  return { findings, records };
}

/**
 * Gate evaluation — deliberately a DIFFERENT entry point from artifact linting.
 *
 * A perfectly valid requirement can still leave stage 2 unable to exit. That is a gate
 * failure, not an invalid artifact, and collapsing the two is how "the lint" becomes a single
 * undifferentiated pass/fail nobody trusts (#46: warn continuously, block at exactly two
 * boundaries).
 *
 * @param {string} stageId e.g. "02-intent-decomposition"
 * @param {{criteria?: Array<{id: string, describe: string, check: (ctx, state) => boolean}>}} [opts]
 */
export function evaluateStageGate(ctx, stageId, opts = {}) {
  const { findings, records } = lintProject(ctx);
  const blocking = findings.filter((f) => f.severity === SEVERITY.ERROR);
  const gateFindings = [];

  // Derivable without the stages/ definition set: every activated type this stage PRODUCES
  // must have produced something. The stage is on the schema (x-stage), not invented here.
  for (const type of ctx.activated) {
    const eff = effectiveSchema(ctx.schemas, type);
    if (eff.stage !== stageId) continue;
    const count = records.filter((r) => r.doc?.type === type).length;
    if (count === 0)
      gateFindings.push(
        finding("gate/no-artifacts-for-stage-type", SEVERITY.ERROR, {
          message: `Stage ${stageId} produces "${type}" and no ${type} artifact exists.`,
          details: { stageId, type },
        })
      );
  }

  // Declared exit criteria come from the single stages/ definition set (#34). Until that
  // exists, say so rather than inventing criteria here — two descriptions of one stage is
  // exactly what #34 forbids.
  const criteria = opts.criteria ?? null;
  for (const c of criteria ?? [])
    if (!c.check(ctx, { findings, records }))
      gateFindings.push(
        finding(`gate/${c.id}`, SEVERITY.ERROR, { message: c.describe, details: { stageId, criterion: c.id } })
      );

  return {
    stageId,
    ready: blocking.length === 0 && gateFindings.length === 0 && criteria !== null,
    criteriaDeclared: criteria !== null,
    blockingArtifactFindings: blocking,
    gateFindings,
    allFindings: findings,
  };
}

/** #46's second boundary. Same engine, different question. */
export function evaluateHandoffGate(ctx, opts = {}) {
  const { findings, records } = lintProject(ctx);
  const blocking = findings.filter((f) => f.severity === SEVERITY.ERROR);
  const advisories = findings.filter((f) => f.severity === SEVERITY.ADVISORY);
  return {
    ready: blocking.length === 0,
    blocking,
    advisories,
    warnings: findings.filter((f) => f.severity === SEVERITY.WARNING),
    artifactCount: records.length,
  };
}
