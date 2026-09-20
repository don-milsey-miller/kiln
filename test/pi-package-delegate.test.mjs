/**
 * `kiln_delegate` as a model receives it — TSK-0053, toward ACC-0111.
 *
 * ⚠️ **THIS CRITERION IS SATISFIED BY WHAT THE WRAPPER DOES NOT CONTAIN.** Every rule of the delegation
 * belongs to `lib/specialists/delegate.mjs`; what is asserted here is that the wrapper calls it exactly
 * once, adds no rule of its own, and renders what comes back through the cleaner every other handler
 * uses.
 *
 * ⚠️ **THE MODEL CHOOSES A ROLE AND A TASK, AND NOTHING ELSE.** Every other input is read from trusted
 * invocation context, so a parameter for any of them would be a way to point a child somewhere else.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { yamlString } from "../lib/project-scaffold.mjs";
import { intakeSection } from "../lib/stage-documents.mjs";
import register from "../pi-package/extensions/kiln.js";
import { providerVisible } from "./helpers/provider-visible.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "sk-ant-api03-DELEGATEWRAPPERPLANTED00000";
const TASK = "Find what the port office publishes about dock-fee reconciliation.";

/**
 * The live selection, as the invocation context carries it.
 *
 * ⚠️ A `sessionManager` IS SUPPLIED ALONGSIDE, HOLDING A DIFFERENT SELECTION. The transcript is
 * history; the context is what this turn runs under, and these cases prove which one is read.
 */
const liveCtx = ({ provider = "openai-codex", model = "gpt-5.6-sol", thinkingLevel = "medium", stale = true } = {}) => ({
  model: provider === null || model === null ? undefined : { provider, id: model },
  // ⚠️ `null` MEANS ABSENT. Passing `undefined` would take the default above and test nothing.
  thinkingLevel: thinkingLevel === null ? undefined : thinkingLevel,
  sessionManager: {
    getEntries: () =>
      stale
        ? [
            { type: "model_change", provider: "stale-provider", modelId: "stale-model" },
            { type: "thinking_level_change", thinkingLevel: "off" },
          ]
        : [],
  },
});

function project() {
  // ⚠️ NOT `kiln-delegate-`. That prefix belongs to the runtime's own workspaces, and the delegate
  // suite guards it by scanning the temporary directory; a fixture sharing it is counted as leaked
  // material by a file running concurrently. The two suites failed together and passed apart.
  const base = mkdtempSync(join(tmpdir(), "kiln-deltool-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, "stages"), { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), `name: ${yamlString("Fixture")}\ndescription: ${yamlString("A project.")}\n`);
  writeFileSync(join(contentRoot, "stages", "01-intake.md"), `# Stage 01 - Intake\n\n${intakeSection()}\n`);
  return { base, contentRoot };
}

/** Every tool name the role may hold, as a measured host would report them. */
const HOST_TOOLS = ["research_capability", "research_search", "research_fetch", "kiln_create_evidence", "kiln_create_assertion", "kiln_create_question", "kiln_link_evidence", "kiln_unlink_evidence"];

const tool = (deps, { measured = HOST_TOOLS } = {}) => {
  const tools = new Map();
  register(
    {
      registerTool: (t) => tools.set(t.name, providerVisible(t)),
      // ⚠️ THE MEASURED REGISTRY, AS PI REPORTS IT: objects with names, not a declaration.
      getAllTools: () => (measured === null ? null : measured.map((name) => ({ name, description: "", parameters: {} }))),
    },
    deps
  );
  return tools.get("kiln_delegate");
};

/** A recording runtime double. It is the only thing the wrapper is allowed to call. */
function runtime(result) {
  const calls = [];
  return {
    calls,
    delegate: async (request, deps) => {
      calls.push({ request, deps });
      return typeof result === "function" ? result(request) : result;
    },
  };
}

const deps = (rt, extra = {}) => ({
  delegate: rt.delegate,
  specialists: { sessionAgentDirectory: () => "/an/isolated/agent/dir", delegateToSpecialist: rt.delegate },
  agentDir: "/an/isolated/agent/dir",
  ...extra,
});

async function invoke(t, contentRoot, params, { ctx = liveCtx(), signal } = {}) {
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = contentRoot;
  try {
    return await t.execute("call-1", params, signal, undefined, ctx);
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
}

const accepted = (over = {}) => ({
  ok: true,
  role: "research",
  output: "The port office publishes a monthly reconciliation summary.",
  observation: {
    role: "research",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "medium",
    activeTools: ["research_capability", "research_search"],
    droppedFromAllowlist: [],
    taskBindingObserved: true,
    timedOut: false,
    aborted: false,
    treeStopped: true,
    ...over,
  },
});

/* ============================================================ the schema ====================== */

test("⚠️ ACC-0111 the schema offers a role and a task, and nothing a caller could point elsewhere with", () => {
  const { parameters } = tool(deps(runtime(accepted())));
  assert.deepEqual(Object.keys(parameters.properties).sort(), ["role", "task"]);
  assert.deepEqual(parameters.required.sort(), ["role", "task"]);
  assert.equal(parameters.additionalProperties, false, "an invented parameter would be accepted");
  assert.deepEqual(parameters.properties.role.enum, ["research", "planning", "validation"]);
  assert.equal(parameters.properties.task.maxLength, 32000, "the task is unbounded, or bounded differently from the runtime");
  assert.equal(parameters.properties.task.minLength, 1);

  // ⚠️ EVERY ONE OF THESE WOULD LET A CALLER REDIRECT A CHILD, LENGTHEN ITS RUN, OR WIDEN ITS TOOLS.
  for (const forbidden of ["provider", "model", "thinkingLevel", "thinking", "agentDir", "toolRoot", "hostRegistry", "tools", "timeoutMs", "timeout", "signal", "hostEnv", "env", "cwd"])
    assert.equal(forbidden in parameters.properties, false, `the schema offers \`${forbidden}\``);
});

/* ============================================================ what it delegates =============== */

test("⚠️ ACC-0111 the wrapper calls the runtime exactly once, with everything from trusted context", async () => {
  const f = project();
  const rt = runtime(accepted());
  try {
    const result = await invoke(tool(deps(rt)), f.contentRoot, { role: "research", task: TASK });
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(rt.calls.length, 1, "the runtime was not called exactly once");

    const { request } = rt.calls[0];
    assert.equal(request.role, "research");
    assert.equal(request.task, TASK);
    // From the session, not from the caller.
    assert.equal(request.provider, "openai-codex");
    assert.equal(request.model, "gpt-5.6-sol");
    assert.equal(request.thinkingLevel, "medium");
    assert.equal(request.agentDir, "/an/isolated/agent/dir");
    assert.equal(request.toolRoot, ROOT);
    assert.ok(Array.isArray(request.hostRegistry) && request.hostRegistry.length > 0);
    // ⚠️ THE TIMEOUT IS THE RUNTIME'S. A wrapper that named one would own a rule that is not its.
    assert.equal("timeoutMs" in request, false, "the wrapper set a timeout of its own");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0111 the invocation's abort signal reaches the runtime", async () => {
  const f = project();
  const rt = runtime(accepted());
  const controller = new AbortController();
  try {
    await invoke(tool(deps(rt)), f.contentRoot, { role: "research", task: TASK }, { signal: controller.signal });
    assert.equal(rt.calls[0].request.signal, controller.signal, "the child cannot be abandoned with the turn");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0111 the wrapper restates no rule of the runtime's", () => {
  // ⚠️ **READ FROM THE SOURCE, BECAUSE THE CRITERION IS ABOUT WHAT IS NOT THERE.** A wrapper that
  // rebuilt launch arguments, judged a binding or removed a workspace would pass every behavioural test
  // above while owning a rule that belongs one layer down.
  // Comments are stripped first, the way the package-purity test does it: a note SAYING the wrapper
  // keeps no nonce is not the wrapper handling one.
  const source = readFileSync(join(ROOT, "pi-package", "extensions", "kiln.js"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const start = source.indexOf('name: "kiln_delegate"');
  const end = source.indexOf("pi?.registerTool?.({", start + 1);
  const wrapper = source.slice(start, end === -1 ? source.length : end);
  assert.ok(wrapper.length > 200, "the wrapper was not located");

  for (const rule of ["--mode", "--no-session", "--prompt-template", "--tools", "stdio", "spawn(", "mkdtemp", "rmSync", "nonce", "sha256", "digest", "stopTree", "trackDescendants", "setTimeout", "verifyChild", "intersect"])
    assert.equal(wrapper.includes(rule), false, `the wrapper restates \`${rule}\``);
});

/* ============================================================ rendering ======================= */

test("⚠️ ACC-0111 a success renders as text content beside the structured result", async () => {
  const f = project();
  try {
    const result = await invoke(tool(deps(runtime(accepted()))), f.contentRoot, { role: "research", task: TASK });
    assert.ok(Array.isArray(result.content) && result.content.length === 1, "no content array");
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.length > 0, "the text content is empty");
    assert.equal(result.output, JSON.stringify(result.details, null, 2), "the output and the details disagree");
    assert.equal(result.details.observed.taskBindingObserved, true);
    assert.deepEqual(Object.keys(result.details).sort(), ["observed", "ok", "output", "role"]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0111 a refusal is structured data with a stable code, and carries no child output", async () => {
  const f = project();
  const refused = {
    ok: false,
    code: "task-not-delivered",
    message: "No task binding was observed for this child, so its output cannot be accepted as an answer to the delegated task.",
    observation: { role: "research", provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "medium", activeTools: [], droppedFromAllowlist: [], taskBindingObserved: false, timedOut: false, aborted: false, treeStopped: true },
  };
  try {
    const result = await invoke(tool(deps(runtime(refused))), f.contentRoot, { role: "research", task: TASK });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.code, "task-not-delivered");
    assert.equal("output" in result.details, false, "a refusal carried the child's output");
    assert.ok(Array.isArray(result.content) && result.content[0].type === "text");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0111 no refusal carries a credential, a path, a nonce, a digest or raw child output", async () => {
  const f = project();
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = SECRET;
  const leaky = {
    ok: false,
    code: "task-not-delivered",
    message: `The child at ${f.contentRoot} failed with ${SECRET}`,
    observation: { role: "research", nonce: "00fece891dbd4927", sha256: "a".repeat(64), workspace: join(tmpdir(), "kiln-delegate-abc"), output: "plausible unverified prose", taskBindingObserved: false },
  };
  try {
    const result = await invoke(tool(deps(runtime(leaky))), f.contentRoot, { role: "research", task: TASK });
    const text = JSON.stringify(result);

    assert.equal(text.includes(SECRET), false, "a credential reached the result");
    assert.equal(text.includes(f.contentRoot), false, "the content root reached the result");
    assert.equal(text.includes(homedir()), false);
    assert.equal(/[A-Za-z]:(\\\\|\/)/.test(text), false, `a drive-lettered path survived: ${text.slice(0, 200)}`);
    assert.equal(text.includes("00fece891dbd4927"), false, "the binding nonce reached the result");
    assert.equal(text.includes("a".repeat(64)), false, "a digest reached the result");
    assert.equal(text.includes("kiln-delegate-abc"), false, "a temporary location reached the result");
    assert.equal(text.includes("plausible unverified prose"), false, "raw child output reached the result");
    // ⚠️ THE TASK IS NOT ECHOED EITHER: a caller already has it, and a transcript does not need it twice.
    assert.equal(text.includes(TASK), false, "the task was echoed back");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================ refusals before delegating ===== */

test("⚠️ F32 an incomplete live selection refuses rather than defaulting any part of it", async () => {
  // ⚠️ **A MISSING THINKING LEVEL IS NOT `off`.** An earlier version inferred it, which would have
  // handed a child a level the orchestrator is not using. Each of the three is required on its own.
  const f = project();
  const rt = runtime(accepted());
  const incomplete = [
    liveCtx({ provider: null }),
    liveCtx({ model: null }),
    liveCtx({ thinkingLevel: null }),
    liveCtx({ thinkingLevel: "" }),
    liveCtx({ provider: "" }),
    liveCtx({ model: "" }),
    {},
  ];
  try {
    for (const ctx of incomplete) {
      const result = await invoke(tool(deps(rt)), f.contentRoot, { role: "research", task: TASK }, { ctx });
      assert.equal(result.details.ok, false, JSON.stringify(ctx?.model ?? null));
      assert.equal(result.details.code, "no-model-selection");
    }
    assert.equal(rt.calls.length, 0, "a child inherited part of a selection");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ F32 the live context overrides a transcript that says something else", async () => {
  // ⚠️ THE FIXTURE'S TRANSCRIPT SAYS `stale-provider / stale-model / off`. The context says otherwise,
  // and the context is what this turn runs under.
  const f = project();
  const rt = runtime(accepted());
  try {
    await invoke(tool(deps(rt)), f.contentRoot, { role: "research", task: TASK }, { ctx: liveCtx({ stale: true }) });
    const { request } = rt.calls[0];
    assert.equal(request.provider, "openai-codex", "a stale transcript entry was read instead of the context");
    assert.equal(request.model, "gpt-5.6-sol");
    assert.equal(request.thinkingLevel, "medium", "a stale thinking level was read instead of the context");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0111 with no isolated agent directory the wrapper refuses rather than letting one default", async () => {
  const f = project();
  const rt = runtime(accepted());
  try {
    const result = await invoke(
      tool({ delegate: rt.delegate, specialists: { sessionAgentDirectory: () => null, delegateToSpecialist: rt.delegate }, hostRegistry: ["research_search"] }),
      f.contentRoot,
      { role: "research", task: TASK }
    );
    assert.equal(result.details.ok, false);
    assert.equal(result.details.code, "no-agent-directory");
    assert.equal(rt.calls.length, 0);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0071 the tool's own content root is refused, through the shared refusal", async () => {
  // ⚠️ THE EXISTING PROJECT-BOUND REFUSAL, NOT A SECOND ONE. Every project-bound handler answers a
  // nested tool content root the same way, and this tool is no exception.
  const rt = runtime(accepted());
  const result = await invoke(tool(deps(rt)), join(ROOT, "planning-content"), { role: "research", task: TASK });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.code, "tool-content-refused");
  assert.equal(result.details.contentRoot, "<content-root>");
  assert.equal(rt.calls.length, 0, "the tool's own content was delegated over");
});

test("⚠️ ACC-0111 a runtime that throws becomes a stable refusal, not a thrown error", async () => {
  const f = project();
  const rt = {
    calls: [],
    delegate: async () => {
      throw new Error(`ENOENT: no such file or directory, open '${join(tmpdir(), "kiln-delegate-xyz", "prompts")}'`);
    },
  };
  try {
    const result = await invoke(tool(deps(rt)), f.contentRoot, { role: "research", task: TASK });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.code, "delegation-failed");
    assert.equal(JSON.stringify(result).includes("ENOENT"), false, "the runtime's error reached the model");
    assert.equal(JSON.stringify(result).includes("kiln-delegate-xyz"), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0065 delegating writes nothing to the project", async () => {
  const f = project();
  const before = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else before.set(full, { bytes: readFileSync(full).toString("base64"), mtimeMs: st.mtimeMs });
    }
  };
  try {
    walk(f.contentRoot);
    await invoke(tool(deps(runtime(accepted()))), f.contentRoot, { role: "research", task: TASK });
    const after = new Map();
    const walkAfter = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walkAfter(full);
        else after.set(full, { bytes: readFileSync(full).toString("base64"), mtimeMs: st.mtimeMs });
      }
    };
    walkAfter(f.contentRoot);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [path, was] of before) assert.deepEqual(after.get(path), was, `${path} changed`);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0111 an invented parameter is ignored even when it reaches the handler", async () => {
  // ⚠️ **`additionalProperties: false` IS PI'S GUARD, NOT THIS HANDLER'S.** A handler that read
  // `params.model` would be one bypassed validation away from letting a caller redirect a child, and a
  // mutation doing exactly that survived until this case was written. The handler is called directly
  // here, which is how anything other than Pi would call it.
  const f = project();
  const rt = runtime(accepted());
  try {
    await invoke(tool(deps(rt)), f.contentRoot, {
      role: "research",
      task: TASK,
      model: "some-other-model",
      provider: "some-other-provider",
      thinkingLevel: "high",
      timeoutMs: 1,
      agentDir: "/somewhere/else",
      hostRegistry: ["bash"],
    });

    const { request } = rt.calls[0];
    assert.equal(request.model, "gpt-5.6-sol", "the caller redirected the child's model");
    assert.equal(request.provider, "openai-codex", "the caller redirected the child's provider");
    assert.equal(request.thinkingLevel, "medium", "the caller changed the child's thinking level");
    assert.equal(request.agentDir, "/an/isolated/agent/dir", "the caller redirected the agent directory");
    assert.equal("timeoutMs" in request, false, "the caller set the timeout");
    assert.equal(request.hostRegistry.includes("bash"), false, "the caller widened the host registry");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================ F33: the MEASURED host registry ================= */

test("⚠️ F33 the registry handed to the runtime is what Pi reports, not what the package declares", async () => {
  // ⚠️ **`signature.json` IS A CLAIM; `pi.getAllTools()` IS A MEASUREMENT.** ACC-0076 asks for the
  // intersection against the host's real registry, and a declaration can name a tool no running session
  // has. Here the declaration and the session disagree, and the runtime must be given the session's.
  const f = project();
  const rt = runtime(accepted());
  const declaration = JSON.parse(readFileSync(join(ROOT, "pi-package", "signature.json"), "utf-8")).tools;
  const measured = ["research_search", "research_capability", "kiln_link_evidence", "a_tool_no_declaration_mentions"];
  try {
    await invoke(tool(deps(rt), { measured }), f.contentRoot, { role: "research", task: TASK });
    const { hostRegistry } = rt.calls[0].request;

    assert.deepEqual([...hostRegistry].sort(), [...measured].sort(), "the runtime was handed something other than the measurement");
    assert.ok(hostRegistry.includes("a_tool_no_declaration_mentions"), "a measured tool absent from the declaration was dropped");
    assert.equal(declaration.includes("a_tool_no_declaration_mentions"), false, "the control is not a control");
    // A declared tool this session does not hold must not appear.
    assert.ok(declaration.includes("kiln_project_status"));
    assert.equal(hostRegistry.includes("kiln_project_status"), false, "the declaration leaked into the registry");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ F33 a role tool the host does not hold is dropped, and a host tool the role lacks is not added", async () => {
  const f = project();
  const rt = runtime(accepted());
  // The host holds one of the role's tools, plus one the role never declares.
  const measured = ["research_search", "kiln_set_review_status"];
  try {
    await invoke(tool(deps(rt), { measured }), f.contentRoot, { role: "research", task: TASK });
    const { hostRegistry } = rt.calls[0].request;

    // The wrapper passes the measurement through; the INTERSECTION itself is the runtime's rule, and
    // `intersectAllowlist` is tested against it directly in test/delegate.test.mjs.
    assert.deepEqual([...hostRegistry].sort(), ["kiln_set_review_status", "research_search"]);
    const { intersectAllowlist } = await import("../lib/specialists/delegate.mjs");
    const { contractFor } = await import("../lib/specialists/contract.mjs");
    const { active, missing } = intersectAllowlist(contractFor("research").tools, hostRegistry);

    assert.deepEqual(active, ["research_search"], "the intersection kept something the host does not hold");
    assert.equal(active.includes("kiln_set_review_status"), false, "a host tool outside the role was added");
    assert.ok(missing.includes("research_fetch"), "a dropped role tool was not reported");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ F33 a registry that cannot be measured refuses before delegating", async () => {
  const f = project();
  const rt = runtime(accepted());
  try {
    // ⚠️ AN UNMEASURABLE HOST IS NOT AN EMPTY HOST. An empty array would intersect to nothing and read
    // as a role with no tools, which is a different and quieter failure.
    for (const measured of [null, []]) {
      const result = await invoke(tool(deps(rt), { measured }), f.contentRoot, { role: "research", task: TASK });
      assert.equal(result.details.ok, false, JSON.stringify(measured));
      assert.equal(result.details.code, "no-host-registry");
    }

    const throwing = await invoke(
      tool({ ...deps(rt), measureHostRegistry: () => { throw new Error("the registry is not available"); } }),
      f.contentRoot,
      { role: "research", task: TASK }
    );
    assert.equal(throwing.details.code, "no-host-registry");
    assert.equal(JSON.stringify(throwing).includes("not available"), false, "the measurement error reached the model");

    assert.equal(rt.calls.length, 0, "a child was delegated with an unmeasured registry");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ F33 the wrapper does not reach for the package declaration at all", () => {
  const source = readFileSync(join(ROOT, "pi-package", "extensions", "kiln.js"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const start = source.indexOf('name: "kiln_delegate"');
  const wrapper = source.slice(start, source.indexOf("pi?.registerTool?.({", start + 1));

  for (const claim of ["declaredToolNames", "signature.json", "SIGNATURE", "packageRootOf", "pi-package.mjs"])
    assert.equal(wrapper.includes(claim), false, `the wrapper reaches for \`${claim}\` instead of measuring`);
  assert.ok(wrapper.includes("measureHostRegistry"), "the wrapper does not measure the registry");
});
