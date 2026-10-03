import { CREDENTIAL_SERVICE } from "./connection-services.mjs";

export { CREDENTIAL_SERVICE } from "./connection-services.mjs";

/**
 * Provider-neutral credential boundary for optional Kiln capabilities.
 *
 * The broker queries one declared service identity at a time. It never enumerates a credential
 * store, never writes project files, and its status result is safe for presentation code.
 */
export const CREDENTIAL_ENV = Object.freeze({
  [CREDENTIAL_SERVICE.TAVILY]: "TAVILY_API_KEY",
  [CREDENTIAL_SERVICE.OPENAI_SOURCE]: "OPENAI_API_KEY",
  [CREDENTIAL_SERVICE.ELEVENLABS]: "ELEVENLABS_API_KEY",
  [CREDENTIAL_SERVICE.TYPESAFE_JEV]: "TYPESAFE_API_KEY",
});

const SERVICES = new Set(Object.values(CREDENTIAL_SERVICE));

export class CredentialBrokerError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "CredentialBrokerError";
    this.reason = reason;
  }
}

function checkedService(service) {
  if (!SERVICES.has(service)) throw new CredentialBrokerError("unknown-service", "Kiln does not have a credential identity for that service.");
  return service;
}

const present = (value) => typeof value === "string" && value.trim().length > 0;

export function createCredentialBroker({ env = process.env, secureStore = null } = {}) {
  const storeAvailable = secureStore?.available === true;
  return Object.freeze({
    async status(service) {
      checkedService(service);
      if (present(env[CREDENTIAL_ENV[service]])) return Object.freeze({ present: true, source: "environment" });
      if (storeAvailable && present(await secureStore.get(service))) return Object.freeze({ present: true, source: "secure-store" });
      return Object.freeze({ present: false, source: "missing", secureStoreAvailable: storeAvailable });
    },

    /** Runtime-only resolution. Renderers receive status(), never this value. */
    async resolve(service) {
      checkedService(service);
      const fromEnvironment = env[CREDENTIAL_ENV[service]];
      if (present(fromEnvironment)) return Object.freeze({ value: fromEnvironment, source: "environment" });
      if (storeAvailable) {
        const value = await secureStore.get(service);
        if (present(value)) return Object.freeze({ value, source: "secure-store" });
      }
      return Object.freeze({ value: null, source: "missing" });
    },

    async store(service, secret) {
      checkedService(service);
      if (!present(secret)) throw new CredentialBrokerError("invalid-secret", "A non-empty credential is required.");
      if (!storeAvailable)
        throw new CredentialBrokerError(
          "secure-store-unavailable",
          `Secure credential storage is unavailable. Set ${CREDENTIAL_ENV[service]} in the environment or skip this connection.`
        );
      await secureStore.set(service, secret);
      return Object.freeze({ stored: true, source: "secure-store" });
    },

    async remove(service) {
      checkedService(service);
      if (!storeAvailable) return Object.freeze({ removed: false, reason: "secure-store-unavailable" });
      const removed = await secureStore.delete(service);
      return Object.freeze({ removed: removed === true, source: "secure-store" });
    },
  });
}

/**
 * Build the environment for one runtime adapter without making the vault part of that adapter's
 * public contract. Callers must perform their project/host permission check before invoking this
 * function: resolving a credential is itself privileged access.
 */
export async function runtimeCredentialEnv(
  service,
  { env = process.env, broker = null, secureStore = null } = {}
) {
  checkedService(service);
  const activeBroker = broker ?? createCredentialBroker({
    env,
    secureStore: secureStore ?? (await createSystemSecureStore()),
  });
  const resolved = await activeBroker.resolve(service);
  if (!present(resolved.value)) return env;
  return { ...env, [CREDENTIAL_ENV[service]]: resolved.value };
}

/** Cross-platform system-vault adapter backed by prebuilt Node-API packages (no setup scripts). */
export async function createSystemSecureStore({ load = null, accountPrefix = "kiln" } = {}) {
  try {
    // A computed specifier keeps an optional native package out of browser bundles while still
    // loading the exact installed package in Node runtimes.
    const loadKeyring = load ?? (() => import(["@napi-rs", "keyring"].join("/")));
    const loaded = await loadKeyring();
    const Entry = loaded.Entry ?? loaded.default?.Entry;
    if (typeof Entry !== "function") return Object.freeze({ available: false });
    const entry = (service) => new Entry("Kiln", `${accountPrefix}:${checkedService(service)}`);
    return Object.freeze({
      available: true,
      get: async (service) => {
        try {
          return await entry(service).getPassword();
        } catch {
          return null;
        }
      },
      set: async (service, value) => entry(service).setPassword(value),
      delete: async (service) => {
        try {
          return (await entry(service).deletePassword()) !== false;
        } catch {
          return false;
        }
      },
    });
  } catch {
    return Object.freeze({ available: false });
  }
}
