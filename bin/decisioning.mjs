#!/usr/bin/env node
/** Configure, probe, and exercise Kiln's optional semantic decisioning layer. */

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { consentLocation } from "../lib/consent-record.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import { currentRoutingContext, readComparisonCandidates, readEvidenceRelationship, readSemanticReviewArtifacts, readTraceCandidates } from "../lib/decisioning/context.mjs";
import { configureDecisioning } from "../lib/decisioning-enablement.mjs";
import { decisioningPermission } from "../lib/decisioning/permission.mjs";
import { createDecisioningTools } from "../lib/decisioning/tools.mjs";
import { createTypeSafeAdapter, TYPESAFE } from "../lib/decisioning/typesafe-adapter.mjs";
import { STATE_MODE, projectRecordState, projectRecordTarget } from "../lib/local-state.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { runTransaction } from "../lib/setup-transaction.mjs";
import { createValidators } from "../lib/validate.mjs";
import * as artifactReader from "../lib/tools/read-artifacts.mjs";

const argv = process.argv.slice(2);
const command = argv[0];
const TOOL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function flag(name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= argv.length || argv[index + 1].startsWith("--")) return undefined;
  return argv[index + 1];
}

function usage() {
  return [
    "Usage:",
    "  npm run decisioning:configure -- --project-root <dir> --provider typesafe|none [--local-state project|user]",
    "  npm run decisioning:probe -- --project-root <dir> [--local-state project|user]",
    '  npm run decisioning:route -- --project-root <dir> --request "..." [--content-root <dir>] [--local-state project|user]',
    '  npm run decisioning:compare -- --project-root <dir> --type requirement --content "..." --candidates REQ-0001,REQ-0002 [--content-root <dir>]',
    "  npm run decisioning:trace -- --project-root <dir> --source CMP-0001 --field satisfies --candidates REQ-0001,REQ-0002 [--content-root <dir>]",
    "  npm run decisioning:evidence -- --project-root <dir> --assertion AST-0001 --evidence EVD-0001 [--content-root <dir>]",
    "  npm run decisioning:review -- --project-root <dir> --artifacts REQ-0001,ACC-0001 [--content-root <dir>]",
    "",
    `${TYPESAFE.envVar} is read only after project choice and host consent permit an operation. It is never written or printed.`,
  ].join("\n");
}

function common() {
  const named = flag("project-root");
  if (!named) throw new Error("--project-root is required.");
  const projectRoot = resolve(named);
  const stateMode = flag("local-state") ?? STATE_MODE.PROJECT;
  if (stateMode !== STATE_MODE.PROJECT && stateMode !== STATE_MODE.USER)
    throw new Error('--local-state must be "project" or "user".');
  const project = projectRecordState(projectRoot);
  if (project.kind !== "valid") throw new Error(`The project's ${project.path} record is ${project.kind}. Run Kiln setup first.`);
  return {
    projectRoot,
    stateMode,
    project,
    location: consentLocation({ projectRoot, stateMode, projectId: project.record.projectId }),
  };
}

function gate(context) {
  const result = decisioningPermission({
    projectRoot: context.projectRoot,
    stateMode: context.stateMode,
  });
  if (!result.permitted) {
    console.error(`REFUSED     ${result.reason}`);
    console.error(`detail      ${result.detail}`);
    return false;
  }
  return true;
}

function planningContext(context) {
  const contentRoot = resolve(flag("content-root") ?? join(context.projectRoot, "planning-content"));
  const schemasDir = join(TOOL_ROOT, "schemas");
  const schemas = loadSchemaSet(schemasDir);
  return {
    contentRoot,
    schemas,
    validators: createValidators(schemasDir),
    activated: readActivatedTypes(contentRoot),
  };
}

async function configure() {
  const context = common();
  const requested = flag("provider");
  const provider = requested === "disabled" ? "none" : requested;
  if (provider !== "typesafe" && provider !== "none")
    throw new Error('--provider must be "typesafe" or "none".');
  const result = await runTransaction(
    { projectRoot: context.projectRoot, files: [projectRecordTarget()] },
    (transaction) => configureDecisioning({
      transaction,
      location: context.location,
      provider,
      adapter: createTypeSafeAdapter(),
    })
  );
  if (!result.ok) {
    console.error(`UNAVAILABLE provider=${provider}`);
    console.error(`reason      ${result.reason}`);
    console.error(`detail      ${result.detail}`);
    console.error(result.message);
    return 1;
  }
  console.log(result.message);
  if (result.available)
    console.log(`probe       model=${result.model}; no inference request was spent`);
  if (result.notRemembered) {
    console.error(result.notRemembered);
    return 1;
  }
  return 0;
}

async function probe() {
  const context = common();
  if (!gate(context)) return 1;
  const out = await createDecisioningTools(createTypeSafeAdapter()).kiln_decisioning_capability();
  if (!out.available) {
    console.error(`UNAVAILABLE backend=${out.backend}`);
    console.error(`reason      ${out.reason}`);
    console.error(`detail      ${out.detail}`);
    return 1;
  }
  console.log(`available   backend=${out.backend} model=${out.model}`);
  console.log(`probe       authenticated model listing; no inference request spent`);
  return 0;
}

async function route() {
  const context = common();
  if (!gate(context)) return 1;
  const request = flag("request");
  if (!request) throw new Error("--request is required.");
  const ctx = planningContext(context);
  const stage = currentRoutingContext(ctx, { toolRoot: TOOL_ROOT });
  if (stage.complete) {
    console.log(JSON.stringify({ ok: true, complete: true, recommendation: null }, null, 2));
    return 0;
  }
  const out = await createDecisioningTools(createTypeSafeAdapter()).kiln_route_turn({ request, stage });
  console.log(JSON.stringify(out, null, 2));
  return out.ok ? 0 : 1;
}

async function compare() {
  const context = common();
  if (!gate(context)) return 1;
  const type = flag("type");
  const content = flag("content");
  const candidateIds = (flag("candidates") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!type || !content || candidateIds.length === 0)
    throw new Error("--type, --content, and a comma-separated --candidates list are required.");
  const ctx = planningContext(context);
  const candidates = readComparisonCandidates({ type, candidateIds }, ctx, artifactReader);
  const out = await createDecisioningTools(createTypeSafeAdapter()).kiln_compare_artifacts({
    type,
    content,
    candidates,
  });
  console.log(JSON.stringify(out, null, 2));
  return out.ok ? 0 : 1;
}

async function trace() {
  const context = common();
  if (!gate(context)) return 1;
  const sourceId = flag("source");
  const field = flag("field");
  const candidateIds = (flag("candidates") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!sourceId || !field || candidateIds.length === 0)
    throw new Error("--source, --field, and a comma-separated --candidates list are required.");
  const ctx = planningContext(context);
  const bounded = readTraceCandidates({ sourceId, field, candidateIds }, ctx, artifactReader);
  const out = await createDecisioningTools(createTypeSafeAdapter()).kiln_rank_trace_targets(bounded);
  console.log(JSON.stringify(out, null, 2));
  return out.ok ? 0 : 1;
}

async function evidence() {
  const context = common();
  if (!gate(context)) return 1;
  const assertionId = flag("assertion");
  const evidenceId = flag("evidence");
  if (!assertionId || !evidenceId) throw new Error("--assertion and --evidence are required.");
  const ctx = planningContext(context);
  const bounded = readEvidenceRelationship({ assertionId, evidenceId }, ctx, artifactReader);
  const out = await createDecisioningTools(createTypeSafeAdapter()).kiln_verify_evidence_relationship(bounded);
  console.log(JSON.stringify(out, null, 2));
  return out.ok ? 0 : 1;
}

async function review() {
  const context = common();
  if (!gate(context)) return 1;
  const artifactIds = (flag("artifacts") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (artifactIds.length === 0) throw new Error("A comma-separated --artifacts list is required.");
  const ctx = planningContext(context);
  const artifacts = readSemanticReviewArtifacts({ artifactIds }, ctx, artifactReader);
  const out = await createDecisioningTools(createTypeSafeAdapter()).kiln_semantic_review({ artifacts });
  console.log(JSON.stringify(out, null, 2));
  return out.ok ? 0 : 1;
}

try {
  if (command === "configure") process.exitCode = await configure();
  else if (command === "probe") process.exitCode = await probe();
  else if (command === "route") process.exitCode = await route();
  else if (command === "compare") process.exitCode = await compare();
  else if (command === "trace") process.exitCode = await trace();
  else if (command === "evidence") process.exitCode = await evidence();
  else if (command === "review") process.exitCode = await review();
  else {
    console.error(usage());
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`REFUSED     ${error?.reason ?? "invalid-command"}`);
  console.error(`detail      ${error?.message ?? String(error)}`);
  console.error("\n" + usage());
  process.exitCode = 2;
}
