/**
 * The public-web boundary for `research_fetch`.
 *
 * ⚠️ **Written because "plain HTTP" was the wrong description and the PM corrected it.** A fetch tool
 * with no destination boundary is not a research capability — it is a request forger sitting inside
 * the host, reachable by anything that can influence a URL. `http://169.254.169.254/` is cloud
 * metadata; `http://localhost:5432` is whatever the PM happens to be running. DEC-0004 scopes the
 * capability to PUBLIC, READ-ONLY internet research, and a scope nothing enforces is a sentence.
 *
 * What it enforces:
 *   - scheme allowlist — `http:` and `https:` only, so `file:`, `ftp:`, `data:`, `gopher:` cannot enter
 *   - no credentials in the URL, which would otherwise be sent to a host and logged by it
 *   - no loopback, private, link-local, unique-local, CGNAT, multicast or reserved destinations
 *   - EVERY redirect revalidated, because the first hop being public says nothing about the second
 *
 * ⚠️ **Residual risk, stated rather than closed: DNS rebinding.** The addresses are resolved and
 * checked, then `fetch` resolves the name again itself, so a hostile authority that answers
 * differently the second time can still move the destination. Closing it means connecting to the
 * checked IP with an explicit Host header and SNI, which Node's fetch does not expose. **The honest
 * position is that this raises the cost of an attack rather than eliminating it**, and a tier-1-style
 * boundary claim (#125) applies here too: say what it does not do.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { REFUSED, requestRefused } from "./refusal.mjs";

export const DEFAULTS = {
  maxRedirects: 5,
  maxBytes: 5_000_000,
  timeoutMs: 20_000,
  allowedMediaTypes: ["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"],
};

/** Blocked IPv4 ranges, as [network, prefix-length]. Everything else is treated as public. */
const V4_BLOCKED = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // CGNAT — shared address space, not the public internet
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local, and where cloud metadata lives
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved, includes 255.255.255.255
];

const v4ToInt = (ip) => ip.split(".").reduce((acc, o) => (acc << 8 >>> 0) + Number(o), 0) >>> 0;

function v4IsBlocked(ip) {
  const addr = v4ToInt(ip);
  return V4_BLOCKED.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) >>> 0 === (v4ToInt(net) & mask) >>> 0;
  });
}

function v6IsBlocked(ip) {
  const a = ip.toLowerCase().split("%")[0];
  if (a === "::1" || a === "::") return true;
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return true; // link-local
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique-local
  if (a.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) is an IPv4 destination wearing an IPv6 hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return v4IsBlocked(mapped[1]);
  return false;
}

export function addressIsBlocked(ip) {
  const family = isIP(ip);
  if (family === 4) return v4IsBlocked(ip);
  if (family === 6) return v6IsBlocked(ip);
  return true; // not an address at all: refuse rather than guess
}

/**
 * Check one URL. Returns `{ok: true, url}` or a `request-refused` object.
 * @param {string} raw
 * @param {{resolve?: (host:string)=>Promise<{address:string}[]>}} [opts] injectable resolver, for tests
 */
export async function checkUrl(raw, opts = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return requestRefused(REFUSED.BLOCKED_SCHEME, `Not a URL: ${String(raw).slice(0, 200)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:")
    return requestRefused(REFUSED.BLOCKED_SCHEME, `Scheme ${url.protocol} is not public web.`, { url: url.href });

  // Credentials in a URL are sent to the host and land in its logs. Refuse rather than strip:
  // silently changing a caller's request is worse than declining it.
  if (url.username || url.password)
    return requestRefused(REFUSED.URL_CREDENTIALS, "URL carries credentials.", { url: `${url.protocol}//${url.host}${url.pathname}` });

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      const resolve = opts.resolve ?? ((h) => lookup(h, { all: true }));
      addresses = await resolve(host);
    } catch (e) {
      return requestRefused(REFUSED.UNRESOLVABLE_HOST, `Cannot resolve ${host}: ${e.code ?? "lookup failed"}`, { url: url.href });
    }
  }

  if (!addresses?.length) return requestRefused(REFUSED.UNRESOLVABLE_HOST, `No addresses for ${host}.`, { url: url.href });

  // EVERY address must be public. A name that resolves to one public and one private address is a
  // name that can send the next connection anywhere.
  const blocked = addresses.map((a) => a.address).filter(addressIsBlocked);
  if (blocked.length)
    return requestRefused(REFUSED.PRIVATE_DESTINATION, `${host} resolves to a non-public address (${blocked[0]}).`, { url: url.href });

  return { ok: true, url: url.href, addresses: addresses.map((a) => a.address) };
}
