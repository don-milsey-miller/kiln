import test from "node:test";
import assert from "node:assert/strict";

import {
  CREDENTIAL_ENV,
  CREDENTIAL_SERVICE,
  CredentialBrokerError,
  createCredentialBroker,
  createSystemSecureStore,
  runtimeCredentialEnv,
} from "../lib/credential-broker.mjs";

const SENTINEL = "kiln-secret-SENTINEL-90f821";

test("credential status is presentation-safe and environment credentials take precedence", async () => {
  const reads = [];
  const broker = createCredentialBroker({
    env: { TAVILY_API_KEY: SENTINEL },
    secureStore: { available: true, get: async (service) => (reads.push(service), "stored-secret") },
  });
  const status = await broker.status(CREDENTIAL_SERVICE.TAVILY);
  assert.deepEqual(status, { present: true, source: "environment" });
  assert.equal(JSON.stringify(status).includes(SENTINEL), false);
  assert.deepEqual(reads, [], "the lower-precedence secure store was queried");
  assert.deepEqual(await broker.resolve(CREDENTIAL_SERVICE.TAVILY), { value: SENTINEL, source: "environment" });
});

test("secure storage is service-scoped and remove touches only the selected entry", async () => {
  const values = new Map();
  const touched = [];
  const secureStore = {
    available: true,
    get: async (service) => values.get(service) ?? null,
    set: async (service, value) => (touched.push(["set", service]), values.set(service, value)),
    delete: async (service) => (touched.push(["delete", service]), values.delete(service)),
  };
  const broker = createCredentialBroker({ env: {}, secureStore });
  await broker.store(CREDENTIAL_SERVICE.ELEVENLABS, SENTINEL);
  assert.deepEqual(await broker.status(CREDENTIAL_SERVICE.ELEVENLABS), { present: true, source: "secure-store" });
  assert.deepEqual(await broker.status(CREDENTIAL_SERVICE.TAVILY), { present: false, source: "missing", secureStoreAvailable: true });
  await broker.remove(CREDENTIAL_SERVICE.ELEVENLABS);
  assert.deepEqual(touched, [["set", CREDENTIAL_SERVICE.ELEVENLABS], ["delete", CREDENTIAL_SERVICE.ELEVENLABS]]);
});

test("an unavailable secure store never falls back to a project or plaintext file", async () => {
  const broker = createCredentialBroker({ env: {}, secureStore: { available: false } });
  await assert.rejects(
    () => broker.store(CREDENTIAL_SERVICE.OPENAI_SOURCE, SENTINEL),
    (error) => error instanceof CredentialBrokerError && error.reason === "secure-store-unavailable" && !error.message.includes(SENTINEL)
  );
  assert.deepEqual(await broker.status(CREDENTIAL_SERVICE.OPENAI_SOURCE), {
    present: false,
    source: "missing",
    secureStoreAvailable: false,
  });
});

test("the system-vault adapter scopes entries by service and fails closed when unavailable", async () => {
  const values = new Map();
  class Entry {
    constructor(service, account) {
      this.key = `${service}/${account}`;
    }
    getPassword() { if (!values.has(this.key)) throw new Error("missing"); return values.get(this.key); }
    setPassword(value) { values.set(this.key, value); }
    deletePassword() { return values.delete(this.key); }
  }
  const store = await createSystemSecureStore({ load: async () => ({ Entry }), accountPrefix: "test" });
  assert.equal(store.available, true);
  await store.set(CREDENTIAL_SERVICE.OPENAI_SOURCE, SENTINEL);
  assert.equal(await store.get(CREDENTIAL_SERVICE.OPENAI_SOURCE), SENTINEL);
  assert.equal(await store.get(CREDENTIAL_SERVICE.ELEVENLABS), null);
  assert.equal(await store.delete(CREDENTIAL_SERVICE.OPENAI_SOURCE), true);
  assert.deepEqual(await createSystemSecureStore({ load: async () => { throw new Error("no vault"); } }), { available: false });
});

test("runtime credential environments preserve env precedence and inject only the requested vault value", async () => {
  const env = { PATH: "fixture", OPENAI_API_KEY: "from-env" };
  const broker = createCredentialBroker({
    env,
    secureStore: {
      available: true,
      get: async (service) => service === CREDENTIAL_SERVICE.TAVILY ? SENTINEL : "wrong-service",
    },
  });
  const openai = await runtimeCredentialEnv(CREDENTIAL_SERVICE.OPENAI_SOURCE, { env, broker });
  assert.deepEqual(openai, env);

  const tavily = await runtimeCredentialEnv(CREDENTIAL_SERVICE.TAVILY, { env, broker });
  assert.notEqual(tavily, env);
  assert.equal(tavily[CREDENTIAL_ENV[CREDENTIAL_SERVICE.TAVILY]], SENTINEL);
  assert.equal(tavily.OPENAI_API_KEY, "from-env");
  assert.equal(Object.values(tavily).includes("wrong-service"), false);
});
