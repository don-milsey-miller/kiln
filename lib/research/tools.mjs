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

// This is a model-context limit, not the network safety limit in url-guard.mjs. The rendered JSON,
// including metadata, must fit inside the requested value; the extension performs the final fit
// because it owns the exact representation Pi sends to the provider.
export const RESEARCH_FETCH_LIMITS = Object.freeze({
  minimumBytes: 4_096,
  defaultBytes: 50_000,
  maximumBytes: 100_000,
});

const normaliseUrl = (raw) => {
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
};

/** A UTF-8 byte range whose edges never split a code point. */
export function utf8Range(text, requestedOffset, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  let start = Math.min(requestedOffset, bytes.length);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let end = Math.min(start + maxBytes, bytes.length);
  while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(start, end).toString("utf8"),
    start,
    end,
    total: bytes.length,
  };
}

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
      "Discover candidate sources for a question. When separately permitted, semantic triage can omit duplicate or irrelevant snippets from downstream context. DISCOVERY ONLY - not evidence, and not an answer.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  research_fetch: {
    description:
      "Retrieve one bounded UTF-8 chunk of a public web page. Continue with offsetBytes, and set refresh:true only to fetch the URL again. Rejects unsafe destinations, oversized downloads and unsupported media types.",
    input: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxBytes: {
          type: "integer",
          minimum: RESEARCH_FETCH_LIMITS.minimumBytes,
          maximum: RESEARCH_FETCH_LIMITS.maximumBytes,
          description: "Maximum UTF-8 bytes in the complete model-visible result. Defaults to 50000.",
        },
        offsetBytes: { type: "integer", minimum: 0, description: "Byte offset returned by the previous chunk's continuation." },
        refresh: { type: "boolean", description: "Fetch again instead of using this session's cached retrieval." },
      },
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

  // One tool object lives for one Pi session. The cache therefore prevents repeated network transfer
  // and repeated context injection without writing retrieved content anywhere outside the tool result.
  const fetchedByUrl = new Map();

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

    const original = result.results.map((entry, index) => ({ id: `result-${index + 1}`, ...entry }));
    const filter = opts.semanticFilter;
    let results = original;
    let triage = { applied: false, originalCount: original.length, selectedCount: original.length };
    if (input?.semanticTriage !== false && typeof filter === "function" && original.length > 0) {
      const decision = await filter({ question: result.query, results: original });
      if (decision?.ok === true) {
        const selected = new Set(decision.selectedIds);
        results = original.filter((entry) => selected.has(entry.id));
        triage = {
          applied: true,
          backend: decision.backend,
          model: decision.model,
          originalCount: original.length,
          selectedCount: results.length,
          omitted: original
            .filter((entry) => !selected.has(entry.id))
            .map(({ id, title, url }) => ({
              id,
              title,
              url,
              assessment: decision.assessments.find((item) => item.resultId === id)?.assessment ?? null,
            })),
          assessments: decision.assessments,
          usage: decision.usage,
          fallback: "Every original result was returned because semantic triage was unavailable.",
        };
      } else if (decision) {
        triage = {
          applied: false,
          originalCount: original.length,
          selectedCount: original.length,
          reason: decision.reason ?? "decisioning-unavailable",
          fallback: "Every original result was returned because semantic triage was unavailable or invalid.",
        };
      }
    }

    return {
      tool: "research_search",
      ok: true,
      kind: "discovery",
      backend: result.backend,
      query: result.query,
      results,
      triage,
      note: "Discovery observations. Not evidence: fetch the authoritative page and record it through the typed evidence path.",
    };
  }

  async function research_fetch(input) {
    const visibleLimit = input?.maxBytes ?? RESEARCH_FETCH_LIMITS.defaultBytes;
    const offset = input?.offsetBytes ?? 0;
    if (!Number.isInteger(visibleLimit) || visibleLimit < RESEARCH_FETCH_LIMITS.minimumBytes || visibleLimit > RESEARCH_FETCH_LIMITS.maximumBytes)
      return {
        tool: "research_fetch",
        ok: false,
        kind: "invalid-input",
        detail: `maxBytes must be an integer from ${RESEARCH_FETCH_LIMITS.minimumBytes} through ${RESEARCH_FETCH_LIMITS.maximumBytes}.`,
        mustRecordGap: false,
      };
    if (!Number.isInteger(offset) || offset < 0)
      return { tool: "research_fetch", ok: false, kind: "invalid-input", detail: "offsetBytes must be a non-negative integer.", mustRecordGap: false };
    if (input?.refresh !== undefined && typeof input.refresh !== "boolean")
      return { tool: "research_fetch", ok: false, kind: "invalid-input", detail: "refresh must be a boolean.", mustRecordGap: false };

    const requestedKey = normaliseUrl(input?.url);
    let cached = input?.refresh === true || requestedKey === null ? null : fetchedByUrl.get(requestedKey);
    let cacheStatus = cached ? "hit" : input?.refresh === true ? "refresh" : "miss";
    if (cached?.servedOffsets.has(offset)) {
      const prior = cached.chunks.get(offset);
      return {
        ...prior,
        body: null,
        bytesReturned: 0,
        duplicate: true,
        cacheStatus: "duplicate-suppressed",
        note:
          "This normalized URL and byte offset were already returned in this session, so the body was omitted. Use its continuation for the next chunk or set refresh:true to retrieve it again.",
      };
    }

    let out = cached?.retrieval;
    if (!out) {
      const fetchOptions = { ...opts };
      delete fetchOptions.semanticFilter;
      delete fetchOptions.networkMaxBytes;
      delete fetchOptions.maxBytes;
      if (Number.isInteger(opts.networkMaxBytes)) fetchOptions.networkMaxBytes = opts.networkMaxBytes;
      out = await guardedFetch(input?.url, fetchOptions);
    }
    if (out.ok === false) return { tool: "research_fetch", ...out, mustRecordGap: false };

    const key = requestedKey ?? normaliseUrl(out.requestedUrl) ?? out.requestedUrl;
    if (!cached || input?.refresh === true) {
      cached = { retrieval: out, servedOffsets: new Set(), chunks: new Map() };
      fetchedByUrl.set(key, cached);
      const finalKey = normaliseUrl(out.url);
      if (finalKey) fetchedByUrl.set(finalKey, cached);
    }

    const range = utf8Range(out.body, offset, visibleLimit);
    if (offset > range.total)
      return {
        tool: "research_fetch",
        ok: false,
        kind: "invalid-input",
        detail: `offsetBytes ${offset} is past the retrieved body (${range.total} bytes).`,
        mustRecordGap: false,
      };

    const result = {
      tool: "research_fetch",
      ok: true,
      kind: "retrieval",
      url: out.url,
      requestedUrl: out.requestedUrl,
      redirectChain: out.redirectChain,
      status: out.status,
      contentType: out.contentType,
      retrievedAt: out.retrievedAt,
      body: range.text,
      bytesRetrieved: out.bytes,
      bytesReturned: range.end - range.start,
      offsetBytes: range.start,
      truncated: range.end < range.total,
      continuation: range.end < range.total ? { offsetBytes: range.end, maxBytes: visibleLimit } : null,
      modelVisibleLimitBytes: visibleLimit,
      duplicate: false,
      cacheStatus,
      note: "Not yet evidence. Record it through the typed evidence path.",
    };
    cached.servedOffsets.add(offset);
    cached.chunks.set(offset, result);
    return result;
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
