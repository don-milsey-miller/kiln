#!/usr/bin/env node
/**
 * ACC-0020's benchmark: the 95th-percentile server-side cost of compiling and rendering the largest
 * stage document, under the protocol that criterion pins — TSK-0014.
 *
 * ⚠️ IT IS A SCRIPT RATHER THAN A TEST BECAUSE IT MUST BE RE-RUNNABLE, NOT BECAUSE IT IS OPTIONAL.
 * A production build plus sixty serial requests does not belong in `npm test`, but a number nobody
 * can reproduce is a number nobody can dispute — and ACC-0020 was amended precisely because the
 * budget without a protocol was not a test. Run it, read the JSON, record it as evidence.
 *
 * ⚠️ THE VERIFICATION CLAUSE IS THE POINT, AND IT CAN VOID THE RUN. The cheapest way to meet a
 * compile budget is to cache the compiled document, which reports excellent numbers while measuring
 * nothing and quietly breaks DEC-0020's request-time requirement. So the server's compile counter
 * must advance by EXACTLY ONE per measured request. If it does not, this exits non-zero and reports
 * VOID — which is not a failure to meet the budget, it is the instrument being wrong, a different
 * problem that must not be recorded as the first one.
 *
 * ⚠️ TWO NUMBERS, EACH HONEST ABOUT WHICH END IT COMES FROM. The protocol's span runs from the
 * request handler beginning the read to the document's markup being complete. The start is
 * observable inside the component; the end is not, because React renders what that component
 * returns after it returns. So the server reports read-plus-compile on a monotonic clock (a lower
 * bound, precisely measured) and this harness closes the span from the other end by stamping when
 * the response body completes (an upper bound, including loopback transit and the rest of the
 * page). If BOTH are within budget the criterion is met on any reading of the boundary; if they
 * straddle it, that is a real ambiguity and it gets reported rather than resolved by choosing the
 * flattering one.
 *
 * ⚠️ IT READS. It issues GET requests against the project's own content and writes nothing.
 */

import { rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus, totalmem } from "node:os";

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4411;
const BASE = `http://127.0.0.1:${PORT}`;
const WARMUP = 10;
const SAMPLE = 50;
const BUDGET_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nextBin = join(ROOT, "node_modules", "next", "dist", "bin", "next");

/** The largest stage document by byte count, named in the result as the protocol requires. */
function largestStageDocument() {
  const dir = join(ROOT, "planning-content", "stages");
  const docs = readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .map((n) => ({ name: n, id: n.replace(/\.md$/, ""), bytes: statSync(join(dir, n)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  if (!docs.length) throw new Error("no stage documents to measure");
  return docs[0];
}

async function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") await execFileP("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    else proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  await sleep(400);
}

/** p95 by the nearest-rank method, stated so the number can be recomputed from the raw samples. */
function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

const stat = (values) => ({
  min: +Math.min(...values).toFixed(2),
  median: +[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2),
  p95: +p95(values).toFixed(2),
  max: +Math.max(...values).toFixed(2),
});

async function main() {
  const doc = largestStageDocument();
  const url = `${BASE}/stage/${doc.id}`;

  console.error(`building… (largest document: ${doc.name}, ${doc.bytes} bytes)`);
  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
  await execFileP(process.execPath, [nextBin, "build"], { cwd: ROOT, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });

  // ⚠️ The content root is passed explicitly rather than inferred, so the run records WHICH content
  // was measured. It is the project's own, read-only.
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      VPW_BENCH: "1",
      PLANNING_CONTENT_DIR: join(ROOT, "planning-content"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  /** Every `vpw-bench` line the server emits, in order. Requests are serial, so order is identity. */
  const marks = [];
  let serverLog = "";
  const onChunk = (buf) => {
    const text = String(buf);
    serverLog += text;
    for (const line of text.split(/\r?\n/)) {
      const at = line.indexOf("vpw-bench ");
      if (at === -1) continue;
      try {
        marks.push(JSON.parse(line.slice(at + "vpw-bench ".length)));
      } catch {
        /* a partial line; the next chunk carries the rest and the count check will catch a loss */
      }
    }
  };
  server.stdout.on("data", onChunk);
  server.stderr.on("data", onChunk);

  try {
    const ready = Date.now() + 90_000;
    for (;;) {
      if (Date.now() > ready) throw new Error(`server never became ready:\n${serverLog}`);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
          await res.text();
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(400);
    }

    /** One request, read to completion, stamping the wall clock when the body ends. */
    const once = async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`unexpected status ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let body = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      const endWall = Date.now();
      return { endWall, body };
    };

    console.error(`warming up (${WARMUP} discarded)…`);
    for (let i = 0; i < WARMUP; i += 1) await once();

    const warmMarks = marks.length;
    console.error(`measuring ${SAMPLE} serial requests…`);
    const samples = [];
    for (let i = 0; i < SAMPLE; i += 1) {
      const { endWall, body } = await once();
      samples.push({ endWall, rendered: body.includes(`data-vpw-document="${doc.name}"`) });
    }

    // ⚠️ The server's lines cross a pipe, so they can still be in flight when the last response has
    // already completed. Killing the server first would lose them and report a VOID run caused by
    // the harness rather than by the application.
    await sleep(1500);
    await killTree(server);

    /* ------------------------------------------------------------------ validity, before results */

    const measured = marks.slice(warmMarks);
    const problems = [];
    if (measured.length !== SAMPLE)
      problems.push(`the server reported ${measured.length} document renders for ${SAMPLE} measured requests`);
    if (measured.some((m) => m.doc !== doc.name))
      problems.push(`a measured request rendered a different document than ${doc.name}`);
    if (measured.some((m) => m.rejected)) problems.push("a measured request rendered a REJECTION, not a document");
    if (samples.some((s) => !s.rendered)) problems.push("a measured response did not contain the document's markup");

    // ⚠️ The clause that matters: one real compile per request, no caching underneath.
    for (let i = 1; i < measured.length; i += 1)
      if (measured[i].compiles - measured[i - 1].compiles !== 1) {
        problems.push(
          `compile counter advanced by ${measured[i].compiles - measured[i - 1].compiles} between measured ` +
            `requests ${i - 1} and ${i} — a request that did not compile makes the run VOID`
        );
        break;
      }

    const environment = {
      os: `${process.platform} ${process.arch}`,
      node: process.version,
      next: JSON.parse(readFileSync(join(ROOT, "node_modules", "next", "package.json"), "utf-8")).version,
      mdx: JSON.parse(readFileSync(join(ROOT, "node_modules", "@mdx-js", "mdx", "package.json"), "utf-8")).version,
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      memoryGb: +(totalmem() / 1024 ** 3).toFixed(1),
      mode: "next build + next start",
    };

    if (problems.length) {
      console.log(
        JSON.stringify({ verdict: "VOID", reason: problems, document: doc, environment, protocol: { WARMUP, SAMPLE, BUDGET_MS } }, null, 2)
      );
      process.exitCode = 1;
      return;
    }

    /* ------------------------------------------------------------------ the two spans */

    const readAndCompile = measured.map((m) => m.readAndCompileMs);
    // ⚠️ SPLIT, because DEC-0020's fallback only helps if the cost is the COMPILER. Reporting one
    // combined figure would let a PM trade away MDX to fix a cost that turns out to be the read.
    const readOnly = measured.map((m) => m.readMs);
    const compileOnly = measured.map((m) => m.compileMs);
    const toMarkup = samples.map((s, i) => s.endWall - measured[i].startWall);

    const result = {
      verdict: p95(readAndCompile) <= BUDGET_MS && p95(toMarkup) <= BUDGET_MS ? "PASS" : "OVER BUDGET",
      budgetMs: BUDGET_MS,
      document: doc,
      protocol: { warmupDiscarded: WARMUP, measured: SAMPLE, concurrency: 1, p95Method: "nearest-rank" },
      environment,
      compilesVerified: {
        firstCounter: measured[0].compiles,
        lastCounter: measured[measured.length - 1].compiles,
        advancedBy: measured[measured.length - 1].compiles - measured[0].compiles,
        expected: SAMPLE - 1,
      },
      readAndCompileMs: { ...stat(readAndCompile), note: "server-side, monotonic clock; a LOWER bound on the protocol's span" },
      readMs: { ...stat(readOnly), note: "planning-content read alone — NOT affected by DEC-0020's markdown fallback" },
      compileMs: { ...stat(compileOnly), note: "restricted-MDX compile alone — the only part the markdown fallback would remove" },
      readToMarkupCompleteMs: {
        ...stat(toMarkup),
        note: "read start (server wall clock) to response body complete (harness wall clock); an UPPER bound, includes loopback and the rest of the page",
      },
      samples: { readAndCompileMs: readAndCompile.map((n) => +n.toFixed(2)), readToMarkupCompleteMs: toMarkup },
    };
    console.log(JSON.stringify(result, null, 2));
    if (result.verdict !== "PASS") process.exitCode = 2;
  } finally {
    await killTree(server);
  }
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
