/**
 * The first research adapter (DEC-0006). **It is an adapter, not the contract** — #124's point is that
 * replacing this file cannot change what `research_search` promises, and the only way that stays true
 * is if nothing outside this file knows the word "Tavily".
 *
 * Why this backend, per the PM: the free plan grants 1,000 monthly credits with no payment card and
 * STOPS when exhausted, which fits REQ-0012 better than a billing-backed allowance; `GET /usage`
 * validates authentication and reports remaining quota **without performing a search**, which is what
 * makes the capability probe meaningful rather than a search that costs a credit to discover it works.
 *
 * ⚠️ **The credential contract is enforced here, in code, not described in a comment.** The key is
 * read from the process environment, used as a header, and **never returned, never logged, never put
 * in an error message.** `sanitise()` is applied to every string this module emits, and a test asserts
 * the key appears nowhere in any result or thrown error on every failure path.
 *
 * ⚠️ **Search is DISCOVERY.** `include_answer` and `include_raw_content` are hard-coded false and
 * `auto_parameters` is hard-coded false, so this cannot quietly become a model answering from someone
 * else's model. Results name candidate URLs; the project's own guarded fetch reads the page.
 */

import { UNAVAILABLE, capabilityUnavailable } from "./refusal.mjs";

export const TAVILY = {
  name: "tavily",
  envVar: "TAVILY_API_KEY",
  base: "https://api.tavily.com",
  // Fixed, not caller-supplied: a predictable one-credit cost is part of why this backend was chosen,
  // and a caller that could set search_depth could spend more than the PM authorised (REQ-0012).
  searchDefaults: { search_depth: "basic", auto_parameters: false, include_answer: false, include_raw_content: false },
};

/** Replace the key with a marker anywhere it might have reached a string. Belt and braces. */
export function sanitise(text, key) {
  if (typeof text !== "string") return text;
  if (!key) return text;
  return text.split(key).join("[redacted:TAVILY_API_KEY]");
}

export function createTavilyAdapter(opts = {}) {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const readKey = () => env[TAVILY.envVar] || null;

  async function call(path, init) {
    const key = readKey();
    if (!key)
      return capabilityUnavailable(
        UNAVAILABLE.NO_CREDENTIAL,
        `${TAVILY.envVar} is not set in this process's environment. The PM supplies it host-side; it is ` +
          `injected only into the research child (DEC-0006).`
      );
    try {
      const res = await doFetch(`${TAVILY.base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${key}`, "content-type": "application/json" },
      });
      return { res, key };
    } catch (e) {
      return capabilityUnavailable(
        UNAVAILABLE.BACKEND_UNREACHABLE,
        sanitise(`${TAVILY.base} did not respond: ${e?.name === "TimeoutError" ? `no response within ${timeoutMs}ms` : e?.code ?? e?.name ?? "unknown"}`, key)
      );
    }
  }

  /** Map an HTTP status to the DISTINCT unavailable reason the PM required for each cause. */
  async function unavailableFromStatus(res, key) {
    if (res.status === 401 || res.status === 403)
      return capabilityUnavailable(UNAVAILABLE.AUTH_FAILED, `${TAVILY.envVar} was rejected (HTTP ${res.status}).`);
    if (res.status === 429)
      return capabilityUnavailable(UNAVAILABLE.QUOTA_EXHAUSTED, "Rate limited or out of credits (HTTP 429).");
    if (res.status === 432 || res.status === 433)
      return capabilityUnavailable(UNAVAILABLE.QUOTA_EXHAUSTED, `Plan limit reached (HTTP ${res.status}).`);
    const body = sanitise(await res.text().catch(() => ""), key).slice(0, 300);
    return capabilityUnavailable(UNAVAILABLE.BACKEND_UNREACHABLE, `HTTP ${res.status} from ${TAVILY.name}. ${body}`);
  }

  return {
    name: TAVILY.name,
    envVar: TAVILY.envVar,

    /**
     * The live probe: authentication AND remaining quota, WITHOUT performing a search.
     * ⚠️ Zero remaining credits is reported as `quota-exhausted` rather than as available — a
     * capability that would fail on its next use is not present (DEC-0003's detectability half).
     */
    async probe() {
      const out = await call("/usage", { method: "GET" });
      if (out.ok === false) return out;
      const { res, key } = out;
      if (!res.ok) return unavailableFromStatus(res, key);

      let usage = null;
      try {
        usage = await res.json();
      } catch {
        return capabilityUnavailable(UNAVAILABLE.BACKEND_UNREACHABLE, "/usage did not return JSON.");
      }

      const plan = usage?.account?.plan_usage ?? usage?.account?.current_plan_usage ?? null;
      const limit = usage?.account?.plan_limit ?? usage?.account?.current_plan_limit ?? null;
      const remaining = Number.isFinite(plan) && Number.isFinite(limit) ? limit - plan : null;

      if (remaining !== null && remaining <= 0)
        return capabilityUnavailable(UNAVAILABLE.QUOTA_EXHAUSTED, `No credits remaining (${plan}/${limit} used).`, {
          quota: { used: plan, limit, remaining },
        });

      return {
        ok: true,
        backend: TAVILY.name,
        // ⚠️ `remaining: null` means the shape changed, NOT that quota is fine. Reported as unknown
        // rather than assumed — an absent fact caps what can be claimed, it does not fill itself in (#122).
        quota: { used: plan, limit, remaining },
        checkedWithoutSearching: true,
      };
    },

    /** Discovery only. Returns candidate URLs; nothing here is evidence (#124). */
    async search(query, { maxResults = 5 } = {}) {
      const out = await call("/search", {
        method: "POST",
        body: JSON.stringify({ ...TAVILY.searchDefaults, query, max_results: maxResults }),
      });
      if (out.ok === false) return out;
      const { res, key } = out;
      if (!res.ok) return unavailableFromStatus(res, key);

      let payload;
      try {
        payload = await res.json();
      } catch {
        return capabilityUnavailable(UNAVAILABLE.BACKEND_UNREACHABLE, "/search did not return JSON.");
      }

      return {
        ok: true,
        backend: TAVILY.name,
        query,
        results: (payload?.results ?? []).map((r) => ({
          title: sanitise(r.title ?? null, key),
          url: r.url ?? null,
          snippet: sanitise(typeof r.content === "string" ? r.content.slice(0, 500) : null, key),
          publishedAt: r.published_date ?? null,
        })),
      };
    },
  };
}
