/**
 * 7a steps 1, 2 and 5 — the tools, the live probe, and the refusal path.
 *
 * ⚠️ **The refusal tests are the point of this file** (#127). A research capability that has only
 * been tested working has not been tested at all: the clause that prevents #67's failure is the one
 * that fires when the backend is missing, rejecting, exhausted or unreachable.
 *
 * Constructed fixtures throughout (#117) — every backend response here is built to hit a branch. A
 * live Tavily call is 7a step 4 and waits on QST-0011's credential.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createResearchTools, RESEARCH_FETCH_LIMITS, RESEARCH_TOOL_SIGNATURES, researchToolRegistrations } from "../lib/research/tools.mjs";
import { createTavilyAdapter, sanitise, TAVILY } from "../lib/research/tavily-adapter.mjs";
import { checkUrl, addressIsBlocked } from "../lib/research/url-guard.mjs";
import { guardedFetch } from "../lib/research/guarded-fetch.mjs";
import { UNAVAILABLE, REFUSED, mustRecordGap } from "../lib/research/refusal.mjs";

const KEY = "tvly-SECRET-do-not-leak-0123456789";
const publicResolve = async () => [{ address: "93.184.216.34" }];

/** A fake backend. `reply` decides what the next call returns. */
const stubFetch = (reply) => async (url, init) => reply(url, init);
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const adapterWith = (reply, env = { [TAVILY.envVar]: KEY }) => createTavilyAdapter({ env, fetchImpl: stubFetch(reply) });

/* ------------------------------------------------------------------ step 1: the tools exist */

test("three tools are registered, with declared input schemas", () => {
  const tools = createResearchTools(adapterWith(() => json(200, {})));
  const regs = researchToolRegistrations(tools);
  assert.deepEqual(regs.map((r) => r.name).sort(), ["research_capability", "research_fetch", "research_search"]);
  for (const r of regs) {
    assert.equal(typeof r.handler, "function", `${r.name} must have a handler`);
    assert.equal(r.inputSchema.type, "object");
    assert.equal(r.inputSchema.additionalProperties, false);
  }
  // The signatures are readable WITHOUT a backend — a contract writer and #81's check both need that.
  assert.ok(RESEARCH_TOOL_SIGNATURES.research_search.input.required.includes("query"));
  assert.equal(RESEARCH_TOOL_SIGNATURES.research_fetch.input.properties.maxBytes.maximum, RESEARCH_FETCH_LIMITS.maximumBytes);
  assert.ok(RESEARCH_TOOL_SIGNATURES.research_fetch.input.properties.offsetBytes);
  assert.ok(RESEARCH_TOOL_SIGNATURES.research_fetch.input.properties.refresh);
});

test("the contract layer names no vendor", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/research/tools.mjs", import.meta.url), "utf-8");
  assert.equal(/tavily/i.test(src), false, "tools.mjs must not know which backend it is talking to (#124)");
});

/* ---------------------------------------------------- step 2: the live probe, and step 5: refusals */

test("probe reports available only after a live check, and reports quota", async () => {
  let path = null;
  const adapter = adapterWith((url) => {
    path = new URL(url).pathname;
    return json(200, { account: { plan_usage: 12, plan_limit: 1000 } });
  });
  const out = await createResearchTools(adapter).research_capability();
  assert.equal(out.available, true);
  assert.equal(out.probedLive, true);
  assert.deepEqual(out.quota, { used: 12, limit: 1000, remaining: 988 });
  assert.equal(path, "/usage", "the probe must validate auth WITHOUT spending a search credit");
});

test("the four unavailable causes report four distinct reasons", async () => {
  const cases = [
    ["missing key", {}, () => json(200, {}), UNAVAILABLE.NO_CREDENTIAL],
    ["rejected key", { [TAVILY.envVar]: KEY }, () => json(401, { error: "unauthorized" }), UNAVAILABLE.AUTH_FAILED],
    ["out of credits", { [TAVILY.envVar]: KEY }, () => json(429, { error: "rate limited" }), UNAVAILABLE.QUOTA_EXHAUSTED],
    ["unreachable", { [TAVILY.envVar]: KEY }, () => { throw Object.assign(new Error("boom"), { code: "ENOTFOUND" }); }, UNAVAILABLE.BACKEND_UNREACHABLE],
  ];
  for (const [label, env, reply, expected] of cases) {
    const out = await createResearchTools(adapterWith(reply, env)).research_capability();
    assert.equal(out.available, false, label);
    assert.equal(out.reason, expected, label);
    assert.equal(out.mustRecordGap, true, label);
  }
});

test("zero remaining credits is unavailable, not available-with-a-warning", async () => {
  const adapter = adapterWith(() => json(200, { account: { plan_usage: 1000, plan_limit: 1000 } }));
  const out = await createResearchTools(adapter).research_capability();
  assert.equal(out.available, false);
  assert.equal(out.reason, UNAVAILABLE.QUOTA_EXHAUSTED);
});

test("an unreadable quota shape is reported as unknown, never as fine", async () => {
  const adapter = adapterWith(() => json(200, { account: { something_else: 1 } }));
  const out = await createResearchTools(adapter).research_capability();
  assert.equal(out.available, true, "auth succeeded, so the capability is present");
  assert.equal(out.quota.remaining, null, "but remaining is UNKNOWN, not assumed (#122)");
});

test("unavailable search refuses and instructs; it never returns prose", async () => {
  const adapter = adapterWith(() => json(401, { error: "unauthorized" }));
  const out = await createResearchTools(adapter).research_search({ query: "what is the current X" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, UNAVAILABLE.AUTH_FAILED);
  assert.equal(out.mustRecordGap, true);
  assert.match(out.instruction, /Do NOT answer from model memory/);
  assert.equal(out.results, undefined, "a refusal must carry no results to be mistaken for an answer");
});

test("search returns discovery, tagged as not-evidence", async () => {
  const adapter = adapterWith((url, init) => {
    const body = JSON.parse(init.body);
    // Cost control is not caller-supplied (REQ-0012): the spend-relevant parameters are fixed here.
    assert.equal(body.search_depth, "basic");
    assert.equal(body.auto_parameters, false);
    assert.equal(body.include_answer, false);
    assert.equal(body.include_raw_content, false);
    return json(200, { results: [{ title: "T", url: "https://example.com/a", content: "snippet", published_date: "2026-01-01" }] });
  });
  const out = await createResearchTools(adapter).research_search({ query: "q" });
  assert.equal(out.kind, "discovery");
  assert.deepEqual(out.results[0], { id: "result-1", title: "T", url: "https://example.com/a", snippet: "snippet", publishedAt: "2026-01-01" });
  assert.deepEqual(out.triage, { applied: false, originalCount: 1, selectedCount: 1 });
  assert.match(out.note, /Not evidence/);
});

test("#64 semantic triage removes low-value snippets from downstream context and keeps review metadata", async () => {
  const adapter = {
    name: "stand-in",
    probe: async () => ({ ok: true }),
    search: async (query) => ({
      ok: true,
      backend: "stand-in",
      query,
      results: [
        { title: "Useful", url: "https://example.com/useful", snippet: "direct answer" },
        { title: "Duplicate", url: "https://example.com/duplicate", snippet: "repeated answer" },
        { title: "Noise", url: "https://example.com/noise", snippet: "unrelated material" },
      ],
    }),
  };
  const semanticFilter = async ({ results }) => ({
    ok: true,
    backend: "typesafe",
    model: "jev-test",
    selectedIds: [results[0].id],
    assessments: results.map((entry, index) => ({
      resultId: entry.id,
      assessment: { type: "choice", choice: index === 0 ? "essential" : index === 1 ? "duplicate" : "irrelevant", confidence: 0.9, probabilities: {} },
    })),
    usage: { input_tokens: 10, output_tokens: 3 },
  });
  const out = await createResearchTools(adapter, { semanticFilter }).research_search({ query: "q" });
  assert.deepEqual(out.results.map((entry) => entry.id), ["result-1"]);
  assert.equal(out.triage.applied, true);
  assert.equal(out.triage.originalCount, 3);
  assert.equal(out.triage.selectedCount, 1);
  assert.deepEqual(out.triage.omitted.map((entry) => entry.id), ["result-2", "result-3"]);
  assert.equal(JSON.stringify(out.triage.omitted).includes("repeated answer"), false, "omitted snippets still consumed downstream context");
  assert.match(out.triage.fallback, /Every original result/);
});

test("#64 invalid or disabled semantic triage returns every original result", async () => {
  const adapter = {
    name: "stand-in",
    probe: async () => ({ ok: true }),
    search: async (query) => ({ ok: true, backend: "stand-in", query, results: [
      { title: "A", url: "https://example.com/a", snippet: "a" },
      { title: "B", url: "https://example.com/b", snippet: "b" },
    ] }),
  };
  let calls = 0;
  const semanticFilter = async () => (calls += 1, { ok: false, reason: "invalid-response" });
  const tools = createResearchTools(adapter, { semanticFilter });
  const fallback = await tools.research_search({ query: "q" });
  const disabled = await tools.research_search({ query: "q", semanticTriage: false });
  assert.equal(fallback.results.length, 2);
  assert.equal(fallback.triage.applied, false);
  assert.equal(fallback.triage.reason, "invalid-response");
  assert.equal(disabled.results.length, 2);
  assert.equal(calls, 1, "disabled triage still invoked decisioning");
});

/* ------------------------------------------------------ the credential contract, as an invariant */

test("the key never appears in any result or error, on any failure path", async () => {
  const replies = [
    () => json(401, { error: `bad key ${KEY}` }),
    () => json(500, { error: `upstream said ${KEY}` }),
    () => json(429, { error: "rate limited" }),
    () => { throw new Error(`connect failed for ${KEY}`); },
    () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
  ];
  for (const reply of replies) {
    const tools = createResearchTools(adapterWith(reply));
    for (const call of [() => tools.research_capability(), () => tools.research_search({ query: "q" })]) {
      let seen;
      try {
        seen = JSON.stringify(await call());
      } catch (e) {
        seen = String(e?.message ?? e);
      }
      assert.equal(seen.includes(KEY), false, `the key leaked: ${seen.slice(0, 200)}`);
    }
  }
});

test("sanitise replaces the key wherever it reached a string", () => {
  assert.equal(sanitise(`before ${KEY} after`, KEY), "before [redacted:TAVILY_API_KEY] after");
  assert.equal(sanitise("nothing to do", KEY), "nothing to do");
});

/* ------------------------------------------------------------- the public-web boundary on fetch */

test("the boundary refuses schemes, URL credentials and non-public destinations", async () => {
  const cases = [
    ["file:///etc/passwd", REFUSED.BLOCKED_SCHEME],
    ["ftp://example.com/x", REFUSED.BLOCKED_SCHEME],
    ["http://user:pw@example.com/", REFUSED.URL_CREDENTIALS],
    ["http://127.0.0.1:5432/", REFUSED.PRIVATE_DESTINATION],
    ["http://169.254.169.254/latest/meta-data/", REFUSED.PRIVATE_DESTINATION],
    ["http://10.0.0.5/", REFUSED.PRIVATE_DESTINATION],
    ["http://192.168.1.1/", REFUSED.PRIVATE_DESTINATION],
    ["http://100.64.0.1/", REFUSED.PRIVATE_DESTINATION],
    ["http://[::1]/", REFUSED.PRIVATE_DESTINATION],
    ["http://[fd00::1]/", REFUSED.PRIVATE_DESTINATION],
  ];
  for (const [url, reason] of cases) {
    const out = await checkUrl(url, { resolve: publicResolve });
    assert.equal(out.ok, false, url);
    assert.equal(out.reason, reason, url);
  }
  assert.equal((await checkUrl("https://example.com/ok", { resolve: publicResolve })).ok, true);
});

test("a name resolving to any private address is refused", async () => {
  const out = await checkUrl("https://sneaky.example/", {
    resolve: async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }],
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, REFUSED.PRIVATE_DESTINATION);
});

test("IPv4-mapped IPv6 does not slip past the IPv4 rules", () => {
  assert.equal(addressIsBlocked("::ffff:127.0.0.1"), true);
  assert.equal(addressIsBlocked("::ffff:169.254.169.254"), true);
  assert.equal(addressIsBlocked("::ffff:93.184.216.34"), false);
  assert.equal(addressIsBlocked("not-an-address"), true, "unparseable must refuse, not pass");
});

test("EVERY redirect is revalidated, not just the first URL", async () => {
  const hops = [];
  const modes = [];
  const fetchImpl = async (url, init) => {
    hops.push(url);
    modes.push(init?.redirect);
    if (hops.length === 1) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    return new Response("should never be reached", { status: 200, headers: { "content-type": "text/plain" } });
  };
  const out = await guardedFetch("https://example.com/start", { fetchImpl, resolve: publicResolve });
  assert.equal(out.ok, false);
  assert.equal(out.reason, REFUSED.PRIVATE_DESTINATION);
  assert.equal(hops.length, 1, "the metadata endpoint must never have been requested");

  // ⚠️ This assertion exists because the one above was green for the wrong reason. A stub cannot
  // follow redirects the way the platform does, so with `redirect: "follow"` the real fetch would
  // swallow the 302 internally and the loop above would never see the second hop — the guard would
  // be bypassed and every test here would still pass. Checking the REQUEST is what the stub can prove.
  assert.deepEqual(modes, ["manual"], "hops must be requested with redirect: manual, or the guard never sees them");
});

test("oversized and unsupported responses are refused", async () => {
  const big = async () => new Response("x".repeat(3000), { status: 200, headers: { "content-type": "text/plain" } });
  const tooBig = await guardedFetch("https://example.com/big", { fetchImpl: big, resolve: publicResolve, maxBytes: 1000 });
  assert.equal(tooBig.reason, REFUSED.TOO_LARGE);

  const binary = async () => new Response("PK", { status: 200, headers: { "content-type": "application/zip" } });
  const wrongType = await guardedFetch("https://example.com/z.zip", { fetchImpl: binary, resolve: publicResolve });
  assert.equal(wrongType.reason, REFUSED.UNSUPPORTED_MEDIA_TYPE);
});

test("a successful fetch records what promotion to evidence needs", async () => {
  const fetchImpl = async () => new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const out = await guardedFetch("https://example.com/page", { fetchImpl, resolve: publicResolve });
  assert.equal(out.ok, true);
  assert.equal(out.contentType, "text/html");
  assert.ok(out.retrievedAt, "retrieval time is required by DEC-0004 for evidence(kind: source)");
  assert.deepEqual(out.redirectChain, ["https://example.com/page"]);
  assert.equal(mustRecordGap(out), false);
});

test("#172 multi-megabyte fetches return deterministic UTF-8 chunks and suppress duplicate context", async () => {
  const source = `${"🧪".repeat(520_000)}END`;
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    return new Response(source, { status: 200, headers: { "content-type": "text/plain" } });
  };
  const tools = createResearchTools(
    { name: "stand-in", envVar: "NONE", probe: async () => ({ ok: true }), search: async () => ({ ok: true, results: [] }) },
    { fetchImpl, resolve: publicResolve }
  );

  const first = await tools.research_fetch({ url: "https://EXAMPLE.com:443/large", maxBytes: 4097 });
  assert.equal(first.ok, true);
  assert.equal(first.bytesRetrieved, Buffer.byteLength(source));
  assert.ok(first.bytesReturned <= 4097);
  assert.equal(Buffer.from(first.body, "utf8").toString("utf8"), first.body, "the first chunk split a UTF-8 code point");
  assert.equal(first.body.includes("�"), false);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.continuation, { offsetBytes: first.bytesReturned, maxBytes: 4097 });
  assert.equal(requests, 1);

  const duplicate = await tools.research_fetch({ url: "https://example.com/large", maxBytes: 4097 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.body, null);
  assert.equal(duplicate.bytesReturned, 0);
  assert.equal(duplicate.cacheStatus, "duplicate-suppressed");
  assert.equal(requests, 1, "a normalized duplicate URL reached the network");

  const next = await tools.research_fetch({
    url: "https://example.com/large",
    offsetBytes: first.continuation.offsetBytes,
    maxBytes: 4097,
  });
  assert.equal(next.ok, true);
  assert.equal(next.cacheStatus, "hit");
  assert.equal(next.offsetBytes, first.continuation.offsetBytes);
  assert.equal(next.body.includes("�"), false);
  assert.equal(requests, 1, "continuation downloaded the page again instead of using the session cache");

  const refreshed = await tools.research_fetch({ url: "https://example.com/large", maxBytes: 4097, refresh: true });
  assert.equal(refreshed.cacheStatus, "refresh");
  assert.equal(requests, 2);

  const overLimit = await tools.research_fetch({ url: "https://example.com/large", maxBytes: RESEARCH_FETCH_LIMITS.maximumBytes + 1 });
  assert.equal(overLimit.kind, "invalid-input");
  assert.match(overLimit.detail, /maxBytes/);
  assert.equal(requests, 2, "invalid output limits must be rejected before retrieval");
});

test("the CLIs never call process.exit, because it crashes after fetch on this platform", async () => {
  // ⚠️ Measured 2026-08-22 on Node 24 / Windows: `process.exit()` after ANY `fetch` aborts with
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and returns 127 — so a correct refusal
  // printed a crash and reported a crash's exit code. `process.exitCode` plus a natural drain exits
  // cleanly. A name check, like #123's: it catches the obvious regression, not a clever equivalent.
  const { readFileSync } = await import("node:fs");
  for (const f of ["../bin/research.mjs", "../bin/research-probe.mjs"]) {
    // Comments are stripped first: both files EXPLAIN why the call is forbidden, and a check that
    // cannot tell an explanation from a call would forbid documenting its own rule.
    const code = readFileSync(new URL(f, import.meta.url), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/process\.exit\s*\(/.test(code), false, `${f} must set process.exitCode instead of calling process.exit()`);
  }
});
