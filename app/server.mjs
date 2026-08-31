#!/usr/bin/env node
/**
 * 5b — the walking skeleton (#55).
 *
 * ⚠️ **This is not the app (#5 says Next.js + MDX). It is the SKELETON**, and the difference is
 * deliberate: the risky surface #55 exists to prove is the watcher, the derivation and the
 * status write-back — not the rendering framework. Scaffolding Next.js first would have spent
 * the step on its least uncertain part. **#5 stands and is untested by this**; see #100.
 *
 * What it proves, which is the list 5b was given:
 *   1. reads canonical assertion and evidence files            (lib/lint.mjs loader)
 *   2. derives verdict and confidence at RENDER time           (#96, never persisted)
 *   3. shows supporting, refuting AND excluded evidence        (with each exclusion's reason)
 *   4. persists no derived value                               (asserted by test)
 *   5. refreshes when an assertion or its evidence changes     (#73 chokidar, events as hints)
 *   6. writes status through the lock + atomic write           (#78 + #72, the first app write)
 *   7. surfaces lint findings without inventing UI rules       (#47 — rendered, not re-judged)
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";

import { resolveContentRoot, resolveInContentRoot } from "../lib/content-root.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators, assertValid } from "../lib/validate.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import { buildViewModel } from "../lib/view/assertion-view.mjs";
import { withLock } from "../lib/lock.mjs";
import { atomicWrite } from "../lib/atomic-write.mjs";
import { artifactRelPath, DATA_DIR } from "../lib/layout.mjs";
import { TEMP_SUFFIX } from "../lib/atomic-write.mjs";
import { LOCK_FILE } from "../lib/tools/create-artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function makeContext(contentRoot) {
  const schemasDir = join(ROOT, "schemas");
  return {
    contentRoot,
    schemas: loadSchemaSet(schemasDir),
    validators: createValidators(schemasDir),
    activated: readActivatedTypes(contentRoot),
  };
}

/**
 * #6 — the status write-back, and the app's first write into files the agent also writes.
 * #78 in earnest: lock → fresh read INSIDE the lock → modify → #72 atomic write → release.
 * ⚠️ The app writes `reviewStatus` only. That is #82's two-axis split doing work: review
 * progress is the app's to change, `lifecycle` is not, and one `status` field would have made
 * this endpoint able to retire an artifact by accident.
 */
/**
 * ⚠️ MOVED 2026-08-22 to lib/tools/review-status.mjs (#145). It used to live here, which meant the
 * ONLY way to approve an artifact was through a running web server — and DEC-0015 now makes approval
 * a publish precondition for executable content. Kept as a thin delegation so the skeleton's route
 * still works and there is exactly one implementation (#47).
 */
export async function writeReviewStatus(ctx, id, type, reviewStatus) {
  const { setReviewStatus } = await import("../lib/tools/review-status.mjs");
  const r = await setReviewStatus(type, id, reviewStatus, {
    contentRoot: ctx.contentRoot,
    schemas: ctx.schemas,
    validators: ctx.validators,
    reviewedBy: "app",
  });
  return r.artifact;
}

/* ------------------------------------------------------------------ rendering */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const VERDICT_LABEL = {
  supported: "supported",
  refuted: "REFUTED",
  contested: "CONTESTED",
  unresolved: "unresolved",
};

function evidenceRow(e, excluded = false) {
  const env = e.environment?.facts ? Object.entries(e.environment.facts).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  return `<li class="ev ${excluded ? "excluded" : e.polarity}">
    <code>${esc(e.ref)}</code> ${esc(e.title ?? "")}
    ${e.kind ? `<span class="tag">${esc(e.kind)}</span>` : ""}
    ${e.outcome ? `<span class="tag">ran: ${esc(e.outcome)}</span>` : ""}
    ${e.match ? `<span class="tag">env: ${esc(e.match)}</span>` : ""}
    ${env ? `<span class="env">${esc(env)}</span>` : ""}
    ${excluded ? `<strong class="why">excluded: ${esc(e.excludedBecause)}</strong>` : ""}
  </li>`;
}

function render(model, contentRoot) {
  const cards = model.assertions
    .map(
      (a) => `<article class="card ${a.verdict}">
      <h2><code>${esc(a.assertion.id)}</code> ${esc(a.assertion.title)}</h2>
      <p class="statement">${esc(a.assertion.statement)}</p>
      <p class="derived">
        <span class="verdict ${a.verdict}">${esc(VERDICT_LABEL[a.verdict])}</span>
        <span class="conf">${esc(a.confidence)}</span>
        <span class="note">derived at render time — not stored (#96)</span>
      </p>
      <p class="promotion">${a.promotion.allowed
        ? "May become an instruction."
        : `<strong>Blocked from becoming an instruction:</strong> ${esc(a.promotion.detail)}`}</p>
      ${a.supporting.length ? `<h3>Supporting</h3><ul>${a.supporting.map((e) => evidenceRow(e)).join("")}</ul>` : ""}
      ${a.refuting.length ? `<h3>Refuting</h3><ul>${a.refuting.map((e) => evidenceRow(e)).join("")}</ul>` : ""}
      ${a.excludedEvidence.length
        ? `<h3>Excluded from the derivation</h3><ul>${a.excludedEvidence.map((e) => evidenceRow(e, true)).join("")}</ul>`
        : ""}
      ${a.findings.length
        ? `<h3>Lint</h3><ul class="findings">${a.findings.map((f) => `<li class="${esc(f.severity)}"><code>${esc(f.ruleId)}</code> ${esc(f.message)}</li>`).join("")}</ul>`
        : ""}
      <form method="POST" action="/status">
        <input type="hidden" name="id" value="${esc(a.assertion.id)}">
        <input type="hidden" name="type" value="assertion">
        <label>review: <select name="reviewStatus">
          ${["draft", "in-review", "approved", "amended"].map((s) => `<option${s === a.assertion.reviewStatus ? " selected" : ""}>${s}</option>`).join("")}
        </select></label>
        <button>Save</button>
      </form>
    </article>`
    )
    .join("");

  const steps = model.steps
    .map(
      (s) => `<article class="card ${s.findings.length ? "refuted" : "supported"}">
      <h2><code>${esc(s.step.id)}</code> ${esc(s.step.title)}</h2>
      <p class="statement">${esc(s.step.instruction)}</p>
      <p>rests on: ${(s.step.restsOn ?? []).map((r) => `<code>${esc(r)}</code>`).join(" ")}</p>
      ${s.findings.length
        ? `<ul class="findings">${s.findings.map((f) => `<li class="${esc(f.severity)}"><code>${esc(f.ruleId)}</code> ${esc(f.message)}</li>`).join("")}</ul>`
        : "<p>No findings.</p>"}
    </article>`
    )
    .join("");

  return `<!doctype html><meta charset="utf-8"><title>Assertions</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;color:#111}
 .card{border:1px solid #ccc;border-left-width:6px;padding:1rem 1.2rem;margin:1rem 0;border-radius:4px}
 .card.supported{border-left-color:#2e7d32}.card.refuted{border-left-color:#c62828}
 .card.contested{border-left-color:#ef6c00}.card.unresolved{border-left-color:#999}
 h2{font-size:1.05rem;margin:0 0 .3rem}h3{font-size:.8rem;text-transform:uppercase;color:#666;margin:.9rem 0 .3rem}
 .statement{margin:.2rem 0 .6rem}
 .verdict{font-weight:700}.verdict.refuted,.verdict.contested{color:#c62828}
 .conf{background:#eee;padding:.1rem .4rem;border-radius:3px;margin-left:.4rem}
 .note{color:#888;font-size:.8rem;margin-left:.5rem}
 ul{margin:.2rem 0;padding-left:1.2rem}li{margin:.15rem 0}
 .ev.excluded{color:#888}.why{color:#c62828}
 .tag{background:#f0f0f0;padding:0 .3rem;border-radius:3px;font-size:.8rem;margin-left:.3rem}
 .env{color:#666;font-size:.8rem;margin-left:.4rem}
 .findings li.error{color:#c62828}.findings li.warning{color:#ef6c00}.findings li.advisory{color:#666}
 code{background:#f6f6f6;padding:0 .25rem;border-radius:3px}
 header{color:#666;font-size:.85rem}
</style>
<header>
  <strong>${model.counts.assertions}</strong> assertions ·
  ${model.counts.contested} contested · ${model.counts.refuted} refuted ·
  ${model.counts.artifacts} artifacts · <code>${esc(contentRoot)}</code>
  <br>Verdict and confidence are computed on every read. Nothing derived is written back.
</header>
${cards || "<p>No assertions.</p>"}
${steps ? `<h1 style="font-size:1rem">Runbook steps</h1>${steps}` : ""}
<script>
  // #73: watcher events are HINTS that something changed, never a description of what.
  // The page re-reads everything rather than trying to patch what it thinks moved.
  new EventSource("/events").onmessage = () => location.reload();
</script>`;
}

/* ------------------------------------------------------------------ server */

export function startServer({ contentRoot, port = 0 } = {}) {
  const root = contentRoot ?? resolveContentRoot();
  const ctx = makeContext(root);
  const clients = new Set();

  // #73: chokidar, ignoreInitial, awaitWriteFinish OFF, and #72's temp suffix ignored so a
  // temp file never looks like a content change.
  const watcher = chokidar.watch(join(root, DATA_DIR), {
    ignoreInitial: true,
    ignored: (p) => p.includes(TEMP_SUFFIX) || p.endsWith(LOCK_FILE),
  });
  const notify = () => {
    for (const res of clients) res.write("data: changed\n\n");
  };
  watcher.on("all", notify);

  const server = createServer(async (req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 500\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && req.url === "/status") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const p = new URLSearchParams(body);
      try {
        await writeReviewStatus(ctx, p.get("id"), p.get("type"), p.get("reviewStatus"));
        res.writeHead(303, { location: "/" }).end();
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain" }).end(e.message);
      }
      return;
    }

    // Built on every request. The derivation is the read path, not a cache.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(render(buildViewModel(ctx), root));
  });

  const watcherReady = new Promise((resolve, reject) => {
    const onReady = () => {
      watcher.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      watcher.off("ready", onReady);
      reject(error);
    };
    watcher.once("ready", onReady);
    watcher.once("error", onError);
  });
  return watcherReady
    .then(() => new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve({
          server,
          watcher,
          port: server.address().port,
          url: `http://127.0.0.1:${server.address().port}/`,
          async close() {
            for (const c of clients) c.end();
            await watcher.close();
            await new Promise((r) => server.close(r));
          },
        });
      });
    }))
    .catch(async (error) => {
      await watcher.close().catch(() => {});
      if (server.listening) await new Promise((r) => server.close(r));
      throw error;
    });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.mjs")) {
  const { url } = await startServer({ port: Number(process.env.PORT ?? 4321) });
  console.log(`Walking skeleton on ${url}`);
  console.log("Watching for changes; verdict and confidence derive on every read (#96).");
}
