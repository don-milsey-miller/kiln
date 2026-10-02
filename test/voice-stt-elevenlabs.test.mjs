import assert from "node:assert/strict";
import test from "node:test";

import { PCM_16000 } from "../lib/voice/audio/ffmpeg-capture.mjs";
import {
  ELEVENLABS_RETENTION,
  ELEVENLABS_STT_ERROR,
  ElevenLabsSttProvider,
} from "../lib/voice/stt/elevenlabs.mjs";

const SECRET = "test-secret-that-must-never-escape";
const TOKEN = "single-use-test-token";

class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.closes = [];
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
    this.message({ message_type: "session_started" });
  }

  message(value) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: typeof value === "string" ? value : JSON.stringify(value) });
    this.dispatchEvent(event);
  }

  fail() {
    this.dispatchEvent(new Event("error"));
  }

  send(value) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(JSON.parse(value));
  }

  close(code, reason) {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function tokenResponse({ status = 200, token = TOKEN } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify({ token });
    },
  };
}

function harness(options = {}) {
  const sockets = [];
  const urls = [];
  const requests = [];
  const fetchImpl = options.fetchImpl ?? (async (url, init) => {
    requests.push({ url, init });
    return tokenResponse();
  });
  const provider = new ElevenLabsSttProvider({
    apiKey: SECRET,
    fetchImpl,
    webSocketFactory(url) {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    retryDelayMs: 1,
    sessionTimeoutMs: 500,
    ...options.provider,
  });
  return { provider, sockets, urls, requests };
}

function flushMessages() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("ElevenLabs exchanges the API key for a single-use token before opening manual PCM transcription", async () => {
  const { provider, sockets, urls, requests } = harness();
  const session = await provider.start({ format: PCM_16000 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["xi-api-key"], SECRET);
  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.searchParams.get("token"), TOKEN);
  assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
  assert.equal(url.searchParams.get("commit_strategy"), "manual");
  assert.equal(url.searchParams.get("enable_logging"), "false");
  assert.equal(urls[0].includes(SECRET), false);
  assert.equal(session.retention, ELEVENLABS_RETENTION.ZERO_RETENTION_REQUESTED_UNCONFIRMED);

  session.close();
  assert.equal(sockets[0].closes.length, 1);
});

test("streaming chunks stay sample-aligned and stopping sends one explicit manual commit", async () => {
  const { provider, sockets } = harness({ provider: { maxChunkBytes: 4 } });
  const session = await provider.start({ format: PCM_16000 });
  session.write(Uint8Array.from([0, 1, 2, 3, 4, 5]));
  session.finish();
  session.finish();

  assert.deepEqual(sockets[0].sent, [
    { message_type: "input_audio_chunk", audio_base_64: Buffer.from([0, 1, 2, 3]).toString("base64") },
    { message_type: "input_audio_chunk", audio_base_64: Buffer.from([4, 5]).toString("base64") },
    { message_type: "input_audio_chunk", audio_base_64: "", commit: true },
  ]);
  assert.throws(() => session.write(Uint8Array.from([0, 1])), { code: ELEVENLABS_STT_ERROR.CHUNK });
  session.close();
});

test("partial and committed transcripts remain distinct provider-neutral events", async () => {
  const { provider, sockets } = harness();
  const partial = [];
  const final = [];
  const session = await provider.start({
    format: PCM_16000,
    onPartial: (event) => partial.push(event),
    onFinal: (event) => final.push(event),
  });
  sockets[0].message({ message_type: "partial_transcript", text: "hello" });
  sockets[0].message({ message_type: "committed_transcript", text: "hello kiln" });
  await flushMessages();

  assert.deepEqual(partial, [{ text: "hello" }]);
  assert.deepEqual(final, [{ text: "hello kiln" }]);
  session.close();
});

test("retention state never claims zero retention and provider logging warnings are sanitized", async () => {
  const { provider, sockets } = harness();
  const warnings = [];
  const session = await provider.start({ format: PCM_16000, onWarning: (warning) => warnings.push(warning) });
  sockets[0].message({
    message_type: "warning",
    warning: `Zero retention mode was not applied; audio is still being logged ${SECRET}`,
  });
  await flushMessages();

  assert.equal(session.retention, ELEVENLABS_RETENTION.LOGGING_ACTIVE);
  assert.deepEqual(warnings, [{
    code: "retention-logging-active",
    message: "ElevenLabs reported that zero retention was not applied; this session is being logged.",
  }]);
  assert.equal(JSON.stringify(warnings).includes(SECRET), false);
  session.close();
});

test("provider failures become stable errors, close the socket, and never expose provider details", async () => {
  const mappings = [
    ["auth_error", ELEVENLABS_STT_ERROR.AUTH],
    ["quota_exceeded", ELEVENLABS_STT_ERROR.QUOTA],
    ["rate_limited", ELEVENLABS_STT_ERROR.RATE_LIMITED],
    ["unaccepted_terms", ELEVENLABS_STT_ERROR.TERMS],
    ["transcriber_error", ELEVENLABS_STT_ERROR.PROTOCOL],
  ];
  for (const [messageType, expectedCode] of mappings) {
    const { provider, sockets } = harness();
    const errors = [];
    await provider.start({ format: PCM_16000, onError: (error) => errors.push(error) });
    sockets[0].message({ message_type: messageType, message: `provider detail ${SECRET}` });
    await flushMessages();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, expectedCode);
    assert.equal(JSON.stringify(errors[0]).includes(SECRET), false);
    assert.equal(sockets[0].closes.length, 1);
  }
});

test("transport send failures close the session and expose only a stable error", async () => {
  const { provider, sockets } = harness();
  const errors = [];
  const session = await provider.start({ format: PCM_16000, onError: (error) => errors.push(error) });
  sockets[0].send = () => {
    throw new Error(`transport detail ${SECRET}`);
  };

  assert.throws(() => session.write(Uint8Array.from([0, 1])), { code: ELEVENLABS_STT_ERROR.CONNECTION });
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(errors[0]).includes(SECRET), false);
  assert.equal(sockets[0].closes.length, 1);
});

test("abort and provider disposal close active sessions idempotently", async () => {
  const abort = new AbortController();
  const first = harness();
  const errors = [];
  await first.provider.start({ format: PCM_16000, signal: abort.signal, onError: (error) => errors.push(error) });
  abort.abort();
  assert.equal(errors[0].code, ELEVENLABS_STT_ERROR.CANCELLED);
  assert.equal(first.sockets[0].closes.length, 1);

  const second = harness();
  await second.provider.start({ format: PCM_16000 });
  await second.provider.dispose();
  await second.provider.dispose();
  assert.equal(second.sockets[0].closes.length, 1);
  await assert.rejects(() => second.provider.start({ format: PCM_16000 }), { code: ELEVENLABS_STT_ERROR.DISPOSED });
});

test("token retries are bounded to pre-audio transient failures and authentication is never retried", async () => {
  let transientCalls = 0;
  const transient = harness({
    fetchImpl: async () => {
      transientCalls += 1;
      return transientCalls === 1 ? tokenResponse({ status: 503 }) : tokenResponse();
    },
  });
  const session = await transient.provider.start({ format: PCM_16000 });
  assert.equal(transientCalls, 2);
  session.close();

  let authCalls = 0;
  const auth = harness({
    fetchImpl: async () => {
      authCalls += 1;
      return tokenResponse({ status: 401 });
    },
  });
  await assert.rejects(() => auth.provider.start({ format: PCM_16000 }), { code: ELEVENLABS_STT_ERROR.AUTH });
  assert.equal(authCalls, 1);
});

test("format, chunk, and inbound message bounds reject malformed data", async () => {
  const invalid = harness();
  await assert.rejects(
    () => invalid.provider.start({ format: { ...PCM_16000, channels: 2 } }),
    { code: ELEVENLABS_STT_ERROR.FORMAT }
  );

  const { provider, sockets } = harness({ provider: { maxMessageBytes: 64 } });
  const errors = [];
  const session = await provider.start({ format: PCM_16000, onError: (error) => errors.push(error) });
  assert.throws(() => session.write(Uint8Array.from([1])), { code: ELEVENLABS_STT_ERROR.CHUNK });
  sockets[0].message("x".repeat(65));
  await flushMessages();
  assert.equal(errors[0].code, ELEVENLABS_STT_ERROR.PROTOCOL);
  assert.equal(sockets[0].closes.length, 1);
});
