/**
 * The two identities an operator may declare for configuration Kiln can neither derive nor digest safely (D22).
 *
 * ⚠️ **IT LIVES ON ITS OWN BECAUSE THE SETUP COMMAND NEEDS IT BEFORE ITS DEPENDENCIES EXIST.** `--endpoint-identity`
 * is an argument, and an argument is checked before anything is installed or written (D26, ACC-0083), so the rule that
 * decides whether a declared endpoint is usable cannot sit in a module that imports a validator library. What it must
 * not become is a second copy of that rule: `lib/runtime-records.mjs` re-exports exactly this, so the key, the schema
 * and the command all canonicalise through one implementation.
 */

/**
 * The shape of a declared request identity, which is the schema's shape.
 *
 * ⚠️ **ONE PATTERN, CHECKED AGAINST THE SCHEMA BY A TEST.** The label is validated on the command line before
 * anything is installed, and again by `kiln-project.schema.json` and `model-compatibility.schema.json` when it is
 * written. Two spellings of one rule would let the command accept a label the record then refuses, which an
 * operator would meet as setup failing after it had already done its work.
 */
export const REQUEST_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,127}$/;

/**
 * Credential shapes a declared identity must not be.
 *
 * ⚠️ **THIS RECOGNISES KEYS; IT DOES NOT IDENTIFY SECRETS.** A declared identity is printed, committed to the
 * project record and written into the compatibility key, so the one mistake worth catching is the common one: an
 * operator pasting the credential where the label belongs. What that catches is a token in a shape somebody
 * publishes — an issuer prefix, a JWT, or a long unbroken high-entropy string. A secret in no recognised shape
 * passes, and nothing here should be read as a guarantee that what was accepted is safe to publish.
 *
 * ⚠️ **AND IT IS A LIST BECAUSE THE THING IT DESCRIBES IS ONE.** The positive rule — "a label names a
 * configuration" — is the shape check beside it; issuer prefixes have no structure to derive, so they are
 * named, with the issuer beside each one so the list can be read and corrected.
 */
const CREDENTIAL_PREFIXES = Object.freeze([
  "sk-", // OpenAI, Anthropic (sk-ant-), and most of what copied them
  "sk_live_", "sk_test_", "pk_live_", "rk_live_", // Stripe
  "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", // GitHub
  "glpat-", // GitLab
  "xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-", // Slack
  "AKIA", "ASIA", // AWS access key ids
  "AIza", "ya29.", // Google
  "hf_", // Hugging Face
  "npm_", // npm
  "dop_v1_", // DigitalOcean
  "SG.", // SendGrid
  "tvly-", // Tavily, which Kiln itself asks for
  "Bearer ", // a header pasted whole
]);

/** Three base64url segments: a JWT, whatever issued it. */
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/**
 * A long unbroken token carrying upper case, lower case and digits, which is what a generated secret looks like
 * and what a name for a configuration does not. Bounded at 32 so that a long descriptive label is still a label.
 */
const OPAQUE_TOKEN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9_-]{32,}$/;

/** Does this text look like a credential somebody pasted? Checked whole, and token by token. */
export function looksLikeCredential(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const parts = [text, ...text.split(/[\s/:@,;]+/).filter(Boolean)];
  return parts.some(
    (part) => CREDENTIAL_PREFIXES.some((prefix) => part.startsWith(prefix)) || JWT.test(part) || OPAQUE_TOKEN.test(part)
  );
}

/** Default ports, so a port is always explicit and two spellings of one endpoint cannot differ. */
const DEFAULT_PORTS = { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443 };

export class EndpointIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "EndpointIdentityError";
  }
}

/**
 * Canonicalise a provider base URL into the structured endpoint identity.
 *
 * ⚠️ **ONE IMPLEMENTATION, BECAUSE A REGEX IN A SCHEMA IS NOT A CANONICALISER.** The first version
 * of determinant 6 was a pattern over a URL string. It correctly excluded userinfo, query and
 * fragment — and still accepted an uppercase hostname, an implicit port and a trailing slash, which
 * are three spellings of one endpoint. Two records for the same endpoint would have compared
 * unequal and re-run a billable check. The schema now describes the parts; this produces them.
 *
 * ⚠️ **REFUSES, NEVER SANITISES.** A query can carry routing, so stripping it would let two
 * differently routed endpoints share one proof; and an identity that is only non-secret after
 * userinfo has been removed is not something a persisted file may rely on. An endpoint whose URL
 * cannot be used needs an explicitly declared non-secret identity instead.
 */
export function canonicalizeEndpoint(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    // ⚠️ **THE VALUE IS NOT REPEATED, HERE OR ANYWHERE BELOW.** This is reached both for a configured base URL
    // and for one an operator typed on the command line, and either can be something they pasted by mistake. A
    // refusal that quoted it would put it in a terminal, a log and a CI transcript; what they need is the rule.
    throw new EndpointIdentityError("It is not a URL.");
  }

  if (url.username || url.password)
    throw new EndpointIdentityError(
      "The base URL carries userinfo, which cannot be persisted and must not be stripped — the " +
        "result would be an identity that is only non-secret after sanitising. Declare an explicit " +
        "non-secret endpoint identity instead; without one, no live check can prove this endpoint and setup and launch refuse."
    );
  if (url.search)
    throw new EndpointIdentityError(
      "The base URL carries a query, which can carry routing. Stripping it would let two " +
        "differently routed endpoints share one cached proof. Declare an explicit endpoint identity " +
        "instead; without one, no live check can prove this endpoint and setup and launch refuse."
    );
  if (url.hash) throw new EndpointIdentityError("The base URL carries a fragment, which names nothing on a server.");

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (!port)
    throw new EndpointIdentityError(
      `No port and no default for scheme "${scheme}"; an implicit port would make two spellings of ` +
        "one endpoint into two cache keys."
    );

  // Trailing slash removed except at the root, and empty segments collapsed — canonical, not merely
  // tidy: `/v1` and `/v1/` are one path and must be one key.
  const segments = url.pathname.split("/").filter(Boolean);
  const pathname = segments.length ? `/${segments.join("/")}` : "/";

  // ⚠️ **A PATH IS A PLACE A KEY HIDES.** Userinfo and a query are refused above; a token routed as a path
  // segment is the same mistake wearing a different part of the URL, and this identity is committed and printed.
  if (segments.some((segment) => looksLikeCredential(segment)))
    throw new EndpointIdentityError(
      "One of its path segments is in the shape of an API key or token. An endpoint identity is committed to the " +
        "project record and written into the compatibility key, so it may not carry one."
    );

  return { scheme, hostname: url.hostname.toLowerCase(), port, pathname };
}

