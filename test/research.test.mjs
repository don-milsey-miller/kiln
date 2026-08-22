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

import { createResearchTools, RESEARCH_TOOL_SIGNATURES, researchToolRegistrations } from "../lib/research/tools.mjs";
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
  assert.deepEqual(out.results[0], { title: "T", url: "https://example.com/a", snippet: "snippet", publishedAt: "2026-01-01" });
  assert.match(out.note, /Not evidence/);
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
