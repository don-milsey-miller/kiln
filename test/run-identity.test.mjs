/**
 * The run-identity health answer — CMP-0038, against ACC-0077.
 *
 * ⚠️ **THE RESPONSE IS ASSERTED EXACTLY, NOT SCANNED FOR THINGS THAT SHOULD NOT BE IN IT.** A test
 * that only checks the body against a list of known-sensitive patterns passes on any field nobody
 * thought to pattern-match, and passes just as happily when a field is missing or when two
 * identifiers have been swapped. What holds this contract is the exact key set, in order, and every
 * value compared to what it is supposed to be. The key SET is asserted rather than key order: JSON
 * object order is not part of the protocol. The pattern scan is kept as a second net below and is
 * explicitly the weaker of the two.
 *
 * ⚠️ **THE ROUTE IS READ AS TEXT, NOT IMPORTED.** It imports an `app/server/` adapter, and every
 * adapter's first statement is `import "server-only"`, which throws outside the RSC compiler by
 * design (AST-0033). The body it returns is decided in `lib/run-identity.mjs` precisely so the
 * contract can be exercised for real without a server. What the route itself owes — status, headers
 * and body over real HTTP, and the identity coming from the RUNNING process rather than the build —
 * is proved in `shell-smoke.test.mjs`, which already builds and starts the production server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PORT,
  HEALTH_PATH,
  HEALTH_PROTOCOL,
  NO_BUILD,
  NO_IDENTITY,
  PROJECT_ID_ENV,
  RUN_ID_ENV,
  SERVICE,
  healthIdentity,
  parsePort,
  readSuppliedIdentity,
  toolVersion,
} from "../lib/run-identity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PROJECT = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const identified = { [RUN_ID_ENV]: RUN, [PROJECT_ID_ENV]: PROJECT };

test("an identified run answers with exactly these keys and these values", () => {
  const { status, body } = healthIdentity(identified, { build: "1.2.3" });

  assert.equal(status, 200);
  // ⚠️ THE KEY SET IS THE ASSERTION — sorted, because JSON object order is not part of the protocol
  // and pinning it would fail a reordering that changes nothing a consumer can observe. The key
  // list catches an addition or an omission by name; the value comparison catches everything else.
  assert.deepEqual(Object.keys(body).sort(), ["build", "projectId", "protocol", "runId", "service"]);
  assert.deepEqual(body, {
    service: "kiln",
    protocol: "kiln.health/1",
    runId: RUN,
    projectId: PROJECT,
    build: "1.2.3",
  });

  // ⚠️ AND THE TWO IDENTIFIERS ARE CHECKED AGAINST THE RIGHT SOURCES. `deepEqual` above would pass
  // if both constants happened to be equal; these fail if the fields are ever crossed.
  assert.equal(body.runId, identified[RUN_ID_ENV]);
  assert.equal(body.projectId, identified[PROJECT_ID_ENV]);
  assert.notEqual(body.runId, body.projectId, "two identical identifiers would make a swap invisible");
  assert.equal(SERVICE, "kiln");
  assert.equal(HEALTH_PROTOCOL, "kiln.health/1");
});

test("a process nobody supervised says so, rather than answering with gaps", () => {
  // ⚠️ A 200 WITH THE IDENTITY FIELDS MISSING IS THE "RESPONSE THAT MERELY ARRIVES" REQ-0028
  // REFUSES, and inventing a run ID would be worse: it would make an unsupervised process
  // indistinguishable from a supervised one.
  for (const env of [
    {},
    { [RUN_ID_ENV]: RUN },
    { [PROJECT_ID_ENV]: PROJECT },
    { [RUN_ID_ENV]: "", [PROJECT_ID_ENV]: "" },
  ]) {
    const { status, body } = healthIdentity(env);
    assert.equal(status, 503);
    assert.deepEqual(Object.keys(body).sort(), ["error", "protocol", "service"]);
    assert.deepEqual(body, { service: SERVICE, protocol: HEALTH_PROTOCOL, error: NO_IDENTITY });
  }
});

test("⚠️ an identity that is not whole is not an identity", () => {
  // ⚠️ THIS USED TO ANSWER 200 WITH `build: null` — a five-field identity, four of them right, and
  // the fifth saying nothing. Four correct fields is exactly how a "response that merely arrives"
  // gets past a reader who is checking that the fields are present.
  for (const build of [null, "", "   ", 3, {}, []])
    assert.deepEqual(healthIdentity(identified, { build }), {
      status: 503,
      body: { service: SERVICE, protocol: HEALTH_PROTOCOL, error: NO_BUILD },
    });

  // A version that could carry a path is refused the same way the identifiers are, so the claim
  // covers the WHOLE response rather than the two fields that were easiest to reason about.
  for (const unsafe of ["/home/someone/kiln", "C:\\build\\kiln", "1.0.0 (/opt/kiln)", "a".repeat(65), ".1.0"])
    assert.equal(healthIdentity(identified, { build: unsafe }).body.error, NO_BUILD, `must refuse ${unsafe}`);

  for (const safe of ["0.0.0", "1.2.3", "0.1.0-rc.1", "2.0.0+build.7", "1_2"])
    assert.equal(healthIdentity(identified, { build: safe }).body.build, safe, `must accept ${safe}`);
});

test("⚠️ a non-string identifier is not a string that happens to match", () => {
  // ⚠️ `RegExp.test` COERCES: `IDENTIFIER.test([RUN])` is TRUE, because a one-element array
  // stringifies to its element — and the ARRAY, not the string, is what would have been echoed
  // into the JSON. Environment values are always strings; this function takes any object.
  for (const value of [[RUN], { toString: () => RUN }, Object(RUN)])
    for (const env of [{ ...identified, [RUN_ID_ENV]: value }, { ...identified, [PROJECT_ID_ENV]: value }])
      assert.equal(healthIdentity(env).body.error, NO_IDENTITY, "a lookalike identifier is not one");

  assert.equal(healthIdentity({}).body.error, NO_IDENTITY);
  assert.equal(healthIdentity(undefined, { build: "1.0.0" }).body.error, NO_IDENTITY, "the real environment carries no run identity here");
});

test("⚠️ an identifier that is not an identifier is never echoed, whatever it is", () => {
  // ⚠️ THIS IS WHY THE RESPONSE CANNOT LEAK A PATH: the guarantee is not that path-shaped output is
  // scanned for, it is that anything which is not thirty-two hex characters never reaches the body.
  // A scan only catches the shapes someone thought of; validation catches the ones nobody did.
  const rejected = [
    "C:\\Users\\someone\\project",
    "/home/someone/project",
    "sk-live-0123456789abcdef",
    RUN.toUpperCase(),
    RUN + "0",
    RUN.slice(0, 31),
    "../../etc/passwd",
    "  " + RUN + "  ",
  ];
  for (const value of rejected) {
    for (const env of [
      { ...identified, [RUN_ID_ENV]: value },
      { ...identified, [PROJECT_ID_ENV]: value },
    ]) {
      const { status, body } = healthIdentity(env);
      assert.equal(status, 503, `must refuse ${JSON.stringify(value)}`);
      assert.ok(!JSON.stringify(body).includes(value), "and the rejected value must not appear anywhere");
    }
  }
});

test("the build version comes from the package the code was loaded from", () => {
  // ⚠️ NOT FROM THE ENVIRONMENT. A build version the supervisor supplied would be the supervisor
  // reading back its own input, so it could only ever match — a check that cannot fail.
  const expected = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;
  assert.equal(toolVersion(), expected);
  assert.equal(healthIdentity(identified).body.build, expected);

  // ⚠️ AND IT DISCRIMINATES NOTHING TODAY: this package is `0.0.0` and every build reports it. The
  // field is real and its source is right; the lookalike-defeating work is done by the run ID.
  // Recorded here rather than left for the supervisor's identity check to discover.
  assert.equal(expected, "0.0.0", "when this changes, the build field starts carrying real weight");

  // ⚠️ A PACKAGE IT CANNOT READ IS `null`, AND `null` IS NOT A BUILD IDENTITY. It is not a throw
  // and not an invented version either — and it no longer reaches a 200, which is the repair.
  assert.equal(toolVersion(join(ROOT, "does-not-exist")), null);
  assert.equal(healthIdentity(identified, { build: null }).body.error, NO_BUILD);
});

test("the serialised body contains no path, credential or content — the weaker, second net", () => {
  // ⚠️ THIS PROVES LESS THAN THE TEST ABOVE AND IS KEPT ANYWAY. It cannot catch a field nobody
  // pattern-matched for, which is exactly why it is not the primary assertion; what it does catch
  // is a future field added without anyone revisiting the exact key set.
  const serialised = JSON.stringify(healthIdentity(identified).body);
  for (const forbidden of [/[A-Za-z]:[\\/]/, /(^|")\/(home|Users|etc|var)\//, /\bsk-[A-Za-z0-9]/, /BEGIN [A-Z ]*PRIVATE KEY/])
    assert.ok(!forbidden.test(serialised), `${forbidden} appeared in ${serialised}`);
});

/* ============================================== what the route itself owes ===================== */

test("the route is dynamic, transports the decided status, and forbids caching", () => {
  const src = readFileSync(join(ROOT, "app", "health", "kiln", "route.js"), "utf-8");

  // ⚠️ WITHOUT `force-dynamic` NEXT RENDERS THIS AT BUILD TIME and freezes the build machine's
  // environment into it — the one endpoint whose entire job is to report a fact about the RUNNING
  // process. Asserted statically because catching it dynamically needs a production build.
  assert.match(src, /export const dynamic = "force-dynamic"/);

  // ⚠️ **THE STATUS IS PROVED OVER HTTP IN `shell-smoke.test.mjs`, NOT HERE.** This used to match
  // `/status,/`, which the destructuring line `const { status, body }` already satisfies — so the
  // route could have hardcoded `status: 200` and this would still have passed. A text check that
  // matches the declaration of a variable rather than its use is not a check. What is left here is
  // the narrow, non-vacuous form plus a refusal of any literal status.
  assert.match(src, /new Response\(JSON\.stringify\(body\), \{\s*status,/);
  assert.ok(!/\bstatus:\s*\d/.test(src), "a literal status would report an unsupervised process as ready");
  // ⚠️ A CACHED READINESS ANSWER IS A LOOKALIKE WITH A LONGER REACH: a replayed body says exactly
  // what the supervisor wants to hear, from a process that has gone.
  assert.match(src, /"cache-control": "no-store"/);
  assert.match(src, /application\/json/);
  assert.ok(src.includes(`from "../../server/identity.js"`), "the route reaches lib/ through the door, never around it");
});

test("the path the supervisor polls and the directory the route lives in are the same", () => {
  // ⚠️ TWO PLACES SPELL THIS, so they are compared rather than trusted: a supervisor polling
  // `/health/kiln` while the route sits at `/kiln/health` fails as a readiness timeout, which reads
  // like the application never started.
  assert.equal(HEALTH_PATH, "/health/kiln");
  assert.ok(
    readFileSync(join(ROOT, "app", ...HEALTH_PATH.slice(1).split("/"), "route.js"), "utf-8").length > 0,
    "the route file must live where HEALTH_PATH says it does"
  );
});

/* ============================================== what the launcher must validate ================= */

test("a port is parsed, not coerced", () => {
  // ⚠️ `Number()` ACCEPTS THINGS A PORT IS NOT. `Number("3000 ")` is 3000, `Number("0x0BB8")` is
  // 3000, and `Number("abc")` is NaN — which the launcher used to hand to `--port` as "NaN".
  assert.deepEqual(parsePort(undefined), { port: DEFAULT_PORT });
  assert.deepEqual(parsePort(null), { port: DEFAULT_PORT }, "absent is absent, however it is spelled");

  // ⚠️ **AN EMPTY VALUE IS A SET VALUE.** `PORT=""` used to select the default, so a supervisor
  // whose port computation produced nothing would bind 3000 silently and then poll the port it
  // thought it had chosen. "Nobody set a port" and "somebody set a port to nothing" want different
  // answers, and only the first has a safe default.
  assert.ok(parsePort("").problem, "an empty PORT is a mistake, not an omission");
  assert.match(parsePort("").problem, /set but empty/);
  assert.match(parsePort("").problem, /3000/, "and says what unsetting it would have given");
  assert.deepEqual(parsePort(undefined, 4413), { port: 4413 });
  assert.deepEqual(parsePort("3000"), { port: 3000 });
  assert.deepEqual(parsePort("1"), { port: 1 });
  assert.deepEqual(parsePort("65535"), { port: 65535 });

  for (const bad of ["abc", "3000 ", " 3000", "0x0BB8", "3000.5", "-1", "+80", "1e3", "8080\n", 3000, [], {}])
    assert.ok(parsePort(bad).problem, `must refuse ${JSON.stringify(bad)}`);
  for (const outOfRange of ["0", "65536", "99999"]) assert.ok(parsePort(outOfRange).problem, outOfRange);

  // ⚠️ The refusal never echoes the value: this reaches the operator's terminal, and REQ-0024 covers
  // emitted log lines.
  assert.ok(!parsePort("abc").problem.includes("abc"));
});

test("a partial or malformed supervisor identity refuses rather than falling back to standalone", () => {
  assert.deepEqual(readSuppliedIdentity({}), { mode: "standalone" });
  assert.deepEqual(readSuppliedIdentity({ PATH: "/usr/bin" }), { mode: "standalone" });
  // Explicitly removed, as a spread with `undefined` does, is still absent.
  assert.deepEqual(readSuppliedIdentity({ [RUN_ID_ENV]: undefined, [PROJECT_ID_ENV]: undefined }), { mode: "standalone" });
  assert.deepEqual(readSuppliedIdentity(identified), { mode: "supervised", runId: RUN, projectId: PROJECT });

  // ⚠️ **FALLING BACK TO STANDALONE IS THE WORST AVAILABLE OPTION.** The shell would start, the
  // supervisor's health poll would never match, and the operator would be shown a readiness timeout
  // — a symptom two processes away from its cause.
  for (const env of [
    { [RUN_ID_ENV]: RUN },
    { [PROJECT_ID_ENV]: PROJECT },
    { [RUN_ID_ENV]: RUN, [PROJECT_ID_ENV]: "nope" },
    { [RUN_ID_ENV]: "/home/someone", [PROJECT_ID_ENV]: PROJECT },
    { [RUN_ID_ENV]: RUN.toUpperCase(), [PROJECT_ID_ENV]: PROJECT },
    { [RUN_ID_ENV]: [RUN], [PROJECT_ID_ENV]: PROJECT },
    // ⚠️ **PRESENT-BUT-EMPTY IS NOT STANDALONE.** These four used to read as a deliberate
    // unsupervised run, so a supervisor whose identity generation produced nothing reached the one
    // route that skipped the partial-identity refusal — and started a shell it could never
    // recognise. Once either NAME is present, both VALUES have to earn it.
    { [RUN_ID_ENV]: "", [PROJECT_ID_ENV]: "" },
    { [RUN_ID_ENV]: "", [PROJECT_ID_ENV]: PROJECT },
    { [RUN_ID_ENV]: RUN, [PROJECT_ID_ENV]: "" },
    { [RUN_ID_ENV]: "" },
  ]) {
    const r = readSuppliedIdentity(env);
    assert.equal(r.mode, "invalid", `must refuse ${JSON.stringify(Object.keys(env))}`);
    assert.match(r.problem, new RegExp(`${RUN_ID_ENV}|${PROJECT_ID_ENV}`), "and must name the variable");
  }

  // ⚠️ IT NAMES THE VARIABLE, NEVER ITS VALUE.
  const leaky = readSuppliedIdentity({ [RUN_ID_ENV]: "/home/someone/secret", [PROJECT_ID_ENV]: PROJECT });
  assert.ok(!leaky.problem.includes("/home/someone/secret"), "a diagnostic must not become a disclosure");

  // Which variable is wrong is said, so the fix does not need a guess.
  assert.match(readSuppliedIdentity({ [RUN_ID_ENV]: "x", [PROJECT_ID_ENV]: PROJECT }).problem, /^KILN_RUN_ID is not/);
  assert.match(readSuppliedIdentity({ [RUN_ID_ENV]: RUN, [PROJECT_ID_ENV]: "x" }).problem, /^KILN_PROJECT_ID is not/);
});
