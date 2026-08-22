/**
 * The three typed research tools — #124's contract, and the only thing a specialist ever sees.
 *
 *   research_capability — what this host can do, PROVEN by a live probe, not declared
 *   research_search     — discovery: candidate URLs for a question
 *   research_fetch      — retrieval: one public page, through the boundary
 *
 * ⚠️ **No vendor name appears in this file.** The adapter is injected. That is what makes DEC-0004's
 * "the backend is replaceable" a property rather than an intention — replaceability that has never
 * been separated from the contract is a claim nobody has tested.
 *
 * ⚠️ **`research_capability` never reports available without a live probe.** #121: a contract may only
 * describe capabilities the host can supply AND detect, and #67 measured what the alternative costs —
 * a session that looked normal with the tools absent and nothing said so. Registration is not
 * capability; installed-but-unusable is unavailable (DEC-0004).
 *
 * ⚠️ **Search results are not evidence, and this layer will not promote them.** They come back tagged
 * `discovery`. Turning a fetched page into `evidence(kind: source)` goes through the typed evidence
 * path, where a human or a specialist decides it bears on a claim — which is #123's boundary at the
 * point new observations enter the system.
 */

import { guardedFetch } from "./guarded-fetch.mjs";
import { UNAVAILABLE, capabilityUnavailable, mustRecordGap } from "./refusal.mjs";

/**
 * The declared signatures. Data, not prose, because #127 says the specialist contracts describe
 * MEASURED signatures — so the contract writer reads this, and #81 checks a child against it.
 */
export const RESEARCH_TOOL_SIGNATURES = {
  research_capability: {
    description:
      "Report whether research is usable on this host, proven by a live backend probe. Returns available:false with a distinct reason when it is not.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  research_search: {
    description:
      "Discover candidate sources for a question. Returns titles, URLs and snippets. DISCOVERY ONLY - not evidence, and not an answer.",
    input: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 }, maxResults: { type: "integer", minimum: 1, maximum: 20 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  research_fetch: {
    description:
      "Retrieve one public web page as text, through the public-web boundary. Rejects non-HTTP(S) schemes, URL credentials, private and link-local destinations, oversized bodies and unsupported media types, and revalidates every redirect.",
    input: {
      type: "object",
      properties: { url: { type: "string" }, maxBytes: { type: "integer", minimum: 1024 } },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

/**
 * Build the three tools over an adapter.
 * @param {{name: string, envVar: string, probe: Function, search: Function}} adapter
 */
export function createResearchTools(adapter, opts = {}) {
  if (!adapter?.probe || !adapter?.search)
    throw new Error("A research adapter must supply probe() and search().");

  async function research_capability() {
    const probe = await adapter.probe();
    if (mustRecordGap(probe))
      return {
        tool: "research_capability",
        available: false,
        backend: adapter.name,
        reason: probe.reason,
        detail: probe.detail,
        // The specialist contract switches on this: a gap is RECORDED, never worked around.
        mustRecordGap: true,
        signatures: RESEARCH_TOOL_SIGNATURES,
      };
    return {
      tool: "research_capability",
      available: true,
      backend: adapter.name,
      quota: probe.quota ?? null,
      probedLive: true,
      signatures: RESEARCH_TOOL_SIGNATURES,
    };
  }

  async function research_search(input) {
    const query = input?.query;
    if (typeof query !== "string" || !query.trim())
      return { tool: "research_search", ok: false, kind: "invalid-input", detail: "`query` is required." };

    const result = await adapter.search(query, { maxResults: input?.maxResults ?? 5 });
    if (result.ok === false)
      return {
        tool: "research_search",
        ...result,
        mustRecordGap: mustRecordGap(result),
        // ⚠️ The clause 7a exists to prove. Spelled out in the RESULT, not only in the contract,
        // because the contract is a document the child may not re-read and this is data it must handle.
        instruction:
          "Research is unavailable. Return a capability refusal and record the gap. Do NOT answer from model memory.",
      };

    return {
      tool: "research_search",
      ok: true,
      kind: "discovery",
      backend: result.backend,
      query: result.query,
      results: result.results,
      note: "Discovery observations. Not evidence: fetch the authoritative page and record it through the typed evidence path.",
    };
  }

  async function research_fetch(input) {
    const out = await guardedFetch(input?.url, { ...opts, maxBytes: input?.maxBytes ?? opts.maxBytes });
    if (out.ok === false) return { tool: "research_fetch", ...out, mustRecordGap: false };
    return { tool: "research_fetch", ...out, kind: "retrieval", note: "Not yet evidence. Record it through the typed evidence path." };
  }

  return { research_capability, research_search, research_fetch };
}

/**
 * What a host registers. Kept separate from the handlers so binding to a runtime's extension API is
 * a mapping rather than a rewrite — and so the signatures can be read by a contract writer and by
 * #81's check without starting a backend.
 */
export function researchToolRegistrations(tools) {
  return Object.entries(RESEARCH_TOOL_SIGNATURES).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: spec.input,
    handler: tools[name],
  }));
}

export { UNAVAILABLE, capabilityUnavailable };
