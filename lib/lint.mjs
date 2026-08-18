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
import { loadStageDefinitions, producedBy, stageAnnotationDisagreements } from "./stages.mjs";
import { toolRoot } from "./content-root.mjs";
import { effectiveAssertion, mayBecomeInstruction } from "./effective-assertion.mjs";
import { implementedTypes } from "./tools/registry.mjs";

/** error blocks a gate · warning is reported continuously · advisory is expected-for-now (#75). */
export const SEVERITY = { ERROR: "error", WARNING: "warning", ADVISORY: "advisory" };

/**
 * The ONE definition of what blocks. #47 has three callers and #46 has two blocking
 * boundaries; if each caller decided for itself what `error` versus `warning` versus
 * `advisory` meant, three callers would become three enforcement models within a month.
 * Callers render findings. This decides consequences.
 */
export function blocks(f) {
  return f.severity === SEVERITY.ERROR;
}

/** A finding, in the one shape every caller consumes. */
function finding(ruleId, severity, { artifactId = null, path = null, message, details = {} }) {
  return { ruleId, severity, artifactId, path, message, details };
}

const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX|LOREM IPSUM|<placeholder>)\b/i;

/**
 * What an activated type still needs before anything could author it. Observable rather than
 * guessed: a schema in the loaded set, and a typed tool on disk (#88 — nothing else may write).
 */
function missingCapabilities(ctx, type) {
  const missing = [];
  if (!ctx.schemas.types[type]) missing.push("schema");
  if (!(ctx.typedTools ?? implementedTypes()).includes(type)) missing.push("typed tool");
  return missing;
}

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

/**
 * Family 5 — instruction safety (REQ-0009, #57, #58, #96).
 *
 * The rule the whole evidence loop exists for: no instruction may rest on a claim whose
 * DERIVED state does not support it. Needs the evidence graph, so no schema can express it.
 *
 * ⚠️ EVERY premise is checked INDEPENDENTLY, and the rung is never maxed across them.
 * One strong premise cannot compensate for one false premise. Taking the maximum would
 * recreate, at the runbook-step level, exactly the silent inversion #96 removed at the
 * assertion level — a step looking authoritative because its BEST premise is solid while a
 * different premise is refuted.
 */
function instructionSafety(ctx, rec, byId) {
  const f = [];
  const { doc, relPath } = rec;
  if (doc?.type !== "runbook-step") return f;

  const evidenceById = new Map(
    [...byId.entries()].filter(([, r]) => r.doc?.type === "evidence").map(([id, r]) => [id, r.doc])
  );
  const minimumConfidence = doc.destructive ? "environment-matched" : "experimentally-validated";

  for (const ref of doc.restsOn ?? []) {
    const target = byId.get(ref);
    if (!target?.doc) continue; // trace/target-missing already covers this

    const view = effectiveAssertion(target.doc, evidenceById);
    const decision = mayBecomeInstruction(view, { minimumConfidence });
    if (decision.allowed) continue;

    f.push(
      finding(`instruction/rests-on-${decision.because}`, SEVERITY.ERROR, {
        artifactId: doc.id,
        path: relPath,
        message:
          `Step rests on ${ref}, which is ${view.verdict} at ${view.confidence}. ${decision.detail} ` +
          `Checked independently: a sound premise elsewhere does not lift this one.`,
        details: {
          assertion: ref,
          verdict: view.verdict,
          confidence: view.confidence,
          requiredConfidence: minimumConfidence,
          destructive: Boolean(doc.destructive),
          reasons: view.reasons,
        },
      })
    );
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
  f.push(...instructionSafety(ctx, rec, byId));
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
  // #90: `x-stage` is derived metadata. Once stages/ exists it MUST agree with it — a
  // disagreement is two descriptions of one pipeline, which is what #34 forbids.
  const defs = "stageDefinitions" in ctx ? ctx.stageDefinitions : loadStageDefinitions();
  for (const d of stageAnnotationDisagreements(ctx.schemas, defs))
    findings.push(
      finding(
        d.reason === "unresolvable" ? "stage/x-stage-unresolvable" : "stage/x-stage-disagrees",
        SEVERITY.ERROR,
        {
          message:
            d.reason === "unresolvable"
              ? `Schema for "${d.type}" declares x-stage ${JSON.stringify(d.xStage)}, which is not a stage in stages/. ` +
                `A partial definition set must not look like a complete authority (#90).`
              : `Schema for "${d.type}" declares x-stage ${JSON.stringify(d.xStage)} but stages/ says it is produced by ` +
                `${d.producedBy.length ? d.producedBy.join(", ") : "no stage"}. stages/ is authoritative (#34, #90).`,
          details: d,
        }
      )
    );

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

  // ⚠️ WHAT A STAGE PRODUCES COMES FROM stages/ AND NOWHERE ELSE (#34, #90).
  // An earlier version inferred it from the schemas' `x-stage` annotations. That works
  // mechanically and is wrong architecturally: it makes the schemas a second description of
  // the pipeline, which is the drift #34 exists to prevent. `x-stage` is derived metadata for
  // discoverability; the lint checks it AGREES with stages/, and never reads it as authority.
  const defs = "stageDefinitions" in opts ? opts.stageDefinitions : loadStageDefinitions();
  const produces = defs ? producedBy(defs, stageId) : null;

  if (produces)
    for (const type of produces) {
      if (!ctx.activated.includes(type)) continue; // #39: a stage cannot demand an unactivated type

      // ⚠️ A CAPABILITY GAP IS NOT A WORK ITEM (#94). An activated type with no schema cannot
      // be authored at all — no schema means no typed tool means no way to create one. Reporting
      // that as "no artifact exists" reads as unfinished planning when the truth is unbuilt
      // product, which is the same disguise #85's assumption gap wears. Distinct rule, and the
      // two never fire together: there is nothing to say about the artifact count of a type
      // that cannot exist.
      const missing = missingCapabilities(ctx, type);
      if (missing.length) {
        gateFindings.push(
          finding("gate/type-not-implemented", SEVERITY.ERROR, {
            message:
              `Stage ${stageId} produces "${type}", which is activated but not implemented — ` +
              `missing: ${missing.join(", ")}. This is a capability gap, not unfinished planning.`,
            details: { stageId, type, missing, source: "stages/" },
          })
        );
        continue;
      }

      if (records.filter((r) => r.doc?.type === type).length === 0)
        gateFindings.push(
          finding("gate/no-artifacts-for-stage-type", SEVERITY.ERROR, {
            message: `Stage ${stageId} produces "${type}" and no ${type} artifact exists.`,
            details: { stageId, type, source: "stages/" },
          })
        );
    }

  // Exit criteria likewise come from the definition set. Until it exists, say so rather than
  // inventing them here — and refuse to report ready, because a gate that passes for want of
  // criteria is the well-formed false success this whole system is built to prevent.
  const criteria = opts.criteria ?? defs?.[stageId]?.exitCriteria ?? null;

  // ⚠️ ATTESTATION, NOT ACKNOWLEDGEMENT (#93). A criterion nothing can check is not
  // discharged by someone confirming they SAW it — that would let every criterion be
  // "acknowledged" while none was ever judged true, which is the well-formed false success
  // this system keeps closing. The PM records a RESULT, and the result is the thing the gate
  // reads. #59 acknowledges a known exception; this evaluates whether a criterion holds.
  const attestations = opts.attestations ?? {};
  const RESULTS = new Set(["satisfied", "not-satisfied", "n/a"]);
  const pendingHuman = [];

  for (const c of criteria ?? []) {
    if (typeof c.check === "function") {
      if (!c.check(ctx, { findings, records }))
        gateFindings.push(
          finding(`gate/${c.id}`, SEVERITY.ERROR, { message: c.describe, details: { stageId, criterion: c.id } })
        );
      continue;
    }

    const a = attestations[c.id];
    if (!a) {
      pendingHuman.push(c.id);
      gateFindings.push(
        finding("gate/criterion-pending-human", SEVERITY.ERROR, {
          message: `"${c.describe}" cannot be checked mechanically and has not been evaluated.`,
          details: { stageId, criterion: c.id, decidedBy: defs?.[stageId]?.decidedBy ?? null, expects: [...RESULTS] },
        })
      );
      continue;
    }

    if (!RESULTS.has(a.result)) {
      gateFindings.push(
        finding("gate/attestation-malformed", SEVERITY.ERROR, {
          message: `Attestation for "${c.id}" has result ${JSON.stringify(a.result)}; expected one of ${[...RESULTS].join(", ")}.`,
          details: { stageId, criterion: c.id, attestation: a },
        })
      );
      continue;
    }

    if (!(typeof a.decidedBy === "string" && a.decidedBy.trim().length > 0)) {
      gateFindings.push(
        finding("gate/attestation-malformed", SEVERITY.ERROR, {
          message: `Attestation for "${c.id}" has no evaluator; decidedBy is required.`,
          details: { stageId, criterion: c.id, attestation: a },
        })
      );
      continue;
    }

    // #45's shape: an exemption carries a required reason, so the lint can count
    // UNJUSTIFIED ones rather than empty ones.
    if (a.result === "n/a" && !(typeof a.reason === "string" && a.reason.trim().length > 0)) {
      gateFindings.push(
        finding("gate/attestation-unjustified", SEVERITY.ERROR, {
          message: `"${c.id}" is attested n/a without a reason.`,
          details: { stageId, criterion: c.id },
        })
      );
      continue;
    }

    if (a.result === "not-satisfied")
      gateFindings.push(
        finding("gate/criterion-not-satisfied", SEVERITY.ERROR, {
          message: `"${c.describe}" was evaluated and found not satisfied.${a.reason ? ` ${a.reason}` : ""}`,
          details: { stageId, criterion: c.id, attestation: a },
        })
      );
  }

  return {
    stageId,
    ready: blocking.length === 0 && gateFindings.length === 0 && criteria !== null && produces !== null,
    criteriaDeclared: criteria !== null,
    stageDefinitionsFound: defs !== null,
    pendingHumanCriteria: pendingHuman,
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
