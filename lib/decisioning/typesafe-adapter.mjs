/**
 * TypeSafe's Jev adapter. Nothing outside this file depends on the vendor SDK.
 *
 * The key is read only when an operation runs, passed directly to a logging-disabled SDK client,
 * and never returned. Error bodies are deliberately not surfaced: they are remote, untrusted, and
 * may echo request content or credentials.
 */

import {
  DECISIONING_UNAVAILABLE,
  decisioningUnavailable,
  invalidDecisioningInput,
} from "./refusal.mjs";

export const TYPESAFE = Object.freeze({
  name: "typesafe",
  envVar: "TYPESAFE_API_KEY",
  defaultModel: "jev-latest",
});

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

export function sanitiseTypeSafeText(value, key) {
  if (typeof value !== "string" || !key) return value;
  return value.split(key).join(`[redacted:${TYPESAFE.envVar}]`);
}

async function defaultClientFactory({ apiKey, timeoutMs, model, fetchImpl }) {
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  return new TypeSafeClient({
    apiKey,
    timeout: timeoutMs,
    defaultModel: model,
    logLevel: "off",
    retry: { maxRetries: 1 },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function classify(error, key) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (status === 401)
    return decisioningUnavailable(
      DECISIONING_UNAVAILABLE.AUTH_FAILED,
      `${TYPESAFE.envVar} was rejected by TypeSafe (HTTP 401).`
    );
  if (status === 403)
    return decisioningUnavailable(
      DECISIONING_UNAVAILABLE.PERMISSION_DENIED,
      "The TypeSafe account is not permitted to use this operation (HTTP 403)."
    );
  if (status === 429)
    return decisioningUnavailable(
      DECISIONING_UNAVAILABLE.RATE_LIMITED,
      "TypeSafe rate-limited the request (HTTP 429). Retry later or use Kiln's existing reasoning path."
    );
  if (status !== null && status >= 500)
    return decisioningUnavailable(
      DECISIONING_UNAVAILABLE.BACKEND_UNREACHABLE,
      `TypeSafe could not complete the request (HTTP ${status}).`
    );

  const name = error?.name ?? "Error";
  if (name === "APIConnectionError" || name === "APITimeoutError" || name === "TypeError")
    return decisioningUnavailable(
      DECISIONING_UNAVAILABLE.BACKEND_UNREACHABLE,
      `TypeSafe did not respond (${sanitiseTypeSafeText(name, key)}).`
    );
  return decisioningUnavailable(
    DECISIONING_UNAVAILABLE.INVALID_RESPONSE,
    `TypeSafe returned an unusable response (${sanitiseTypeSafeText(name, key)}).`
  );
}

function validQuestions(questions) {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) return false;
  const entries = Object.entries(questions);
  if (entries.length === 0) return false;
  return entries.every(([id, question]) =>
    nonEmpty(id) && question !== null && typeof question === "object" &&
    ["choice", "score", "noul"].includes(question.type)
  );
}

export function createTypeSafeAdapter(options = {}) {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const model = options.model ?? TYPESAFE.defaultModel;
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const readKey = () => (nonEmpty(env[TYPESAFE.envVar]) ? env[TYPESAFE.envVar].trim() : null);

  async function client() {
    const key = readKey();
    if (!key)
      return decisioningUnavailable(
        DECISIONING_UNAVAILABLE.NO_CREDENTIAL,
        `${TYPESAFE.envVar} is not set in this process's environment.`
      );
    try {
      const value = await clientFactory({
        apiKey: key,
        timeoutMs,
        model,
        fetchImpl: options.fetchImpl,
      });
      return { ok: true, client: value, key };
    } catch (error) {
      return classify(error, key);
    }
  }

  return {
    name: TYPESAFE.name,
    envVar: TYPESAFE.envVar,
    model,

    /** GET /v1/models authenticates without spending an inference request. */
    async probe() {
      const connected = await client();
      if (connected.ok === false) return connected;
      try {
        const models = await connected.client.models.list();
        if (!Array.isArray(models))
          return decisioningUnavailable(
            DECISIONING_UNAVAILABLE.INVALID_RESPONSE,
            "TypeSafe's model probe did not return a model list."
          );
        return {
          ok: true,
          backend: TYPESAFE.name,
          model,
          models: models
            .map((entry) => entry?.name)
            .filter(nonEmpty)
            .sort(),
          checkedWithoutInference: true,
        };
      } catch (error) {
        return classify(error, connected.key);
      }
    },

    async evaluate({ state, questions }) {
      if (!validQuestions(questions))
        return invalidDecisioningInput("`questions` must be a non-empty map of Choice, Score, or Noul questions.");
      const connected = await client();
      if (connected.ok === false) return connected;
      try {
        const result = await connected.client.systemOne({ state, questions, model });
        if (!result || typeof result !== "object" || typeof result.model !== "string" ||
            result.answers === null || typeof result.answers !== "object" || Array.isArray(result.answers))
          return decisioningUnavailable(
            DECISIONING_UNAVAILABLE.INVALID_RESPONSE,
            "TypeSafe's evaluation response did not match the decisioning contract."
          );
        return {
          ok: true,
          backend: TYPESAFE.name,
          model: result.model,
          answers: result.answers,
          usage: result.usage ?? null,
        };
      } catch (error) {
        return classify(error, connected.key);
      }
    },
  };
}
