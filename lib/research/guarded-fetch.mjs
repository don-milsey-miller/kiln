/**
 * `research_fetch`'s engine: retrieve a public web page, with the boundary applied to every hop.
 *
 * ⚠️ **Redirects are followed MANUALLY**, which is the whole reason this file exists rather than a
 * one-line `fetch`. `redirect: "follow"` would validate the URL the caller supplied and then let the
 * server choose the next one — so a public host could redirect straight to `169.254.169.254` and the
 * boundary would have inspected only the doormat. Each hop is re-checked by the same guard.
 *
 * ⚠️ **The body is read with a cap and aborted past it**, rather than downloaded and measured. A limit
 * enforced after the fact is a limit that has already been exceeded.
 */

import { checkUrl, DEFAULTS } from "./url-guard.mjs";
import { withTimeout } from "./timeout.mjs";
import { REFUSED, requestRefused } from "./refusal.mjs";

/**
 * @param {string} target
 * @param {{fetchImpl?: typeof fetch, resolve?: Function, maxRedirects?: number, maxBytes?: number,
 *          timeoutMs?: number, allowedMediaTypes?: string[], now?: () => Date}} [opts]
 */
export async function guardedFetch(target, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const doFetch = opts.fetchImpl ?? fetch;
  const startedAt = (opts.now ?? (() => new Date()))();

  let current = target;
  const chain = [];

  for (let hop = 0; hop <= cfg.maxRedirects; hop++) {
    const checked = await checkUrl(current, { resolve: opts.resolve });
    if (!checked.ok) return { ...checked, redirectChain: chain };
    chain.push(checked.url);

    let res;
    const clock = withTimeout(cfg.timeoutMs);
    try {
      res = await doFetch(checked.url, {
        redirect: "manual",
        signal: clock.signal,
        headers: { accept: cfg.allowedMediaTypes.join(", "), "user-agent": cfg.userAgent ?? "visual-project-workflow/research" },
      });
    } catch (e) {
      clock.cancel();
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      return timedOut
        ? requestRefused(REFUSED.TIMEOUT, `No response within ${cfg.timeoutMs}ms.`, { url: checked.url, redirectChain: chain })
        : requestRefused(REFUSED.HTTP_ERROR, `Request failed: ${e?.code ?? e?.name ?? "unknown"}`, { url: checked.url, redirectChain: chain });
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), checked.url).href;
      continue; // ...and the loop re-checks it. That is the point.
    }

    if (!res.ok)
      return requestRefused(REFUSED.HTTP_ERROR, `HTTP ${res.status}.`, { url: checked.url, status: res.status, redirectChain: chain });

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType && !cfg.allowedMediaTypes.includes(contentType))
      return requestRefused(REFUSED.UNSUPPORTED_MEDIA_TYPE, `Content-Type ${contentType} is not readable text.`, {
        url: checked.url, contentType, redirectChain: chain,
      });

    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > cfg.maxBytes)
      return requestRefused(REFUSED.TOO_LARGE, `Declared ${declared} bytes, limit ${cfg.maxBytes}.`, { url: checked.url, redirectChain: chain });

    const read = await readCapped(res, cfg.maxBytes);
    if (!read.ok) return { ...read, url: checked.url, redirectChain: chain };

    return {
      ok: true,
      url: checked.url,
      requestedUrl: target,
      redirectChain: chain,
      status: res.status,
      contentType: contentType || null,
      bytes: read.bytes,
      body: read.text,
      // REQ-0004 / DEC-0004: retrieval time is part of what makes this promotable to
      // evidence(kind: source). Recorded here because this is where it is actually known.
      retrievedAt: startedAt.toISOString(),
    };
  }

  return requestRefused(REFUSED.TOO_MANY_REDIRECTS, `More than ${cfg.maxRedirects} redirects.`, { redirectChain: chain });
}

async function readCapped(res, maxBytes) {
  if (!res.body) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text);
    return bytes > maxBytes ? requestRefused(REFUSED.TOO_LARGE, `Body is ${bytes} bytes, limit ${maxBytes}.`) : { ok: true, text, bytes };
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try { await res.body.cancel?.(); } catch {}
      return requestRefused(REFUSED.TOO_LARGE, `Body exceeded ${maxBytes} bytes; download aborted.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf-8"), bytes: total };
}
