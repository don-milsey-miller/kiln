/**
 * The operator session's prompt augmentation is the session's alone - #219.
 *
 * Kiln's extension is loaded in a delegated specialist child as well as in the operator's session, and its
 * `before_agent_start` handler appended the session's frame to both. A child's system prompt is its role definition,
 * and the frame told it to follow the operator's approval rules, and in the usual case to report a code to the
 * operator and stop.
 *
 * ⚠️ **A CHILD GETS NONE OF IT.** Not the material-change rule, the stage frame, the workflow checkpoint, the recovery
 * text or the carry-over. The handler returns nothing for a child, so Pi's prompt is left exactly as Pi built it.
 *
 * ⚠️ **EVERY PART IS PRESENT IN THE SESSION THESE CASES BUILD.** Each case first shows the operator's session
 * receiving all five parts from the same state, so "the child received none" is never true because a part was absent.
 *
 * `test/delegate-real-child.test.mjs` holds the same rule to real children of every role.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { journalLocation } from "../lib/decision-bundle-journal.mjs";
import { isDelegatedChild } from "../lib/specialists/delegated-child.mjs";
import { NONCE_ENV } from "../lib/specialists/task-observer.mjs";
import { stageSkillName } from "../lib/stage-skills.mjs";
import register, { MATERIAL_CHANGE_RULE } from "../pi-package/extensions/kiln.js";
import { removeTestTree } from "./helpers/cleanup.mjs";
import { projectForDelegation } from "./helpers/delegation-project.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "You are the research specialist. Do the one task you are given.";
const PENDING = "CARRIED-PENDING-QUESTION-219: which port office?";
const SKILL_NAME = stageSkillName("01-intake");
const SKILL_FILE = join(ROOT, "pi-package", "skills", SKILL_NAME, "SKILL.md");
/** One recognisable piece of each part of the session's augmentation. */
const PARTS = {
  "material-change rule": MATERIAL_CHANGE_RULE.split("\n")[0],
  "stage frame": "Kiln stage context:",
  "workflow checkpoint": "Kiln workflow checkpoint:",
  "recovery text": "Kiln recovery (compaction-boundary-invalid):",
  "carry-over text": PENDING,
};

/** A project in Stage 1 whose session holds an unfinished bundle, a failed compaction and a carried question. */
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "kiln-child-prompt-"));
  const project = join(base, "project");
  const contentRoot = join(project, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), "name: child prompt fixture\n");
  const { projectId } = await projectForDelegation(project);
  const journal = journalLocation({ projectRoot: project, projectId });
  mkdirSync(dirname(journal.path), { recursive: true });
  writeFileSync(journal.path, '{"an unfinished bundle":"that cannot be validated"}\n');
  return { base, project, contentRoot, journal };
}

/**
 * The extension's handlers for one session over that state.
 *
 * @param {object} extra  further dependencies, `delegatedChild` among them
 */
async function session(f, extra = {}) {
  const handlers = new Map();
  register(
    { registerTool: () => {}, on: (event, handler) => handlers.set(event, handler) },
    {
      decisionBundleJournal: () => f.journal,
      recoveryRequest: { requestRecovery: async () => ({ written: false, code: "recovery-not-supervised" }) },
      carryover: {
        readCarryover: () => ({ reason: "context-recovery", lastOperation: null, pending: { source: "assistant", text: PENDING } }),
        clearCarryover: () => false,
        writeCarryover: async () => ({ written: false, code: "carryover-not-supervised" }),
      },
      ...extra,
    }
  );
  // A compaction Kiln has to cancel leaves a recovery outcome the frame repeats on every later turn.
  const cancelled = await withContent(f, () => handlers.get("session_before_compact")({ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold", willRetry: false }, {}));
  assert.deepEqual(cancelled, { cancel: true }, "the fixture's compaction was not cancelled");
  return handlers.get("before_agent_start");
}

async function withContent(f, fn, env = {}) {
  const names = ["PLANNING_CONTENT_DIR", NONCE_ENV];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  delete process.env[NONCE_ENV];
  Object.assign(process.env, { PLANNING_CONTENT_DIR: f.contentRoot, ...env });
  try {
    return await fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** The event Pi sends, with the stage skill as Pi's loader reports it, or with none. */
const turn = (skills) => [{ type: "before_agent_start", prompt: "the task", systemPrompt: BASE, systemPromptOptions: { skills } }, { sessionManager: { getSessionId: () => "session-219" } }];
const STAGE_CONTEXTS = {
  valid: [{ name: SKILL_NAME, filePath: SKILL_FILE }],
  unavailable: [],
};

for (const [kind, skills] of Object.entries(STAGE_CONTEXTS))
  test(`⚠️ #219 with ${kind === "valid" ? "a valid" : "an unavailable"} stage context, the operator's session receives every part and a delegated child receives nothing`, async () => {
    const f = await fixture();
    try {
      // The control: the same state, in the operator's own session.
      const operator = await withContent(f, async () => (await session(f))(...turn(skills)));
      assert.ok(operator.systemPrompt.startsWith(BASE));
      for (const [part, mark] of Object.entries(PARTS)) assert.ok(operator.systemPrompt.includes(mark), `the session's own frame lacks the ${part}`);
      if (kind === "valid") assert.ok(operator.systemPrompt.includes(readFileSync(SKILL_FILE, "utf-8")), "the session did not receive its stage skill");
      else assert.ok(operator.systemPrompt.includes("Kiln stage context: unavailable."), "the session's stage context was not the unavailable one");

      // A child, by the runtime's own marker in its environment.
      const child = await withContent(f, async () => (await session(f))(...turn(skills)), { [NONCE_ENV]: "0f".repeat(16) });
      assert.equal(child, undefined, `a delegated child's prompt was changed: ${JSON.stringify(child)?.slice(0, 300)}`);

      // And by the seam, so the rule does not rest on this process's environment.
      const told = await withContent(f, async () => (await session(f, { delegatedChild: () => true }))(...turn(skills)));
      assert.equal(told, undefined);
    } finally {
      removeTestTree(f.base, "#219 child prompt");
    }
  });

test("⚠️ #219 the operator's session is unchanged by the question: the same bytes whether or not it is asked", async () => {
  const f = await fixture();
  try {
    for (const skills of Object.values(STAGE_CONTEXTS)) {
      const asked = await withContent(f, async () => (await session(f))(...turn(skills)));
      const answeredNo = await withContent(f, async () => (await session(f, { delegatedChild: () => false }))(...turn(skills)));
      // A check that cannot be made leaves the process a session, as it was before the check existed.
      const failed = await withContent(f, async () =>
        (
          await session(f, {
            delegatedChild: () => {
              throw new Error("cannot ask");
            },
          })
        )(...turn(skills))
      );
      assert.equal(typeof asked.systemPrompt, "string");
      assert.equal(answeredNo.systemPrompt, asked.systemPrompt);
      assert.equal(failed.systemPrompt, asked.systemPrompt);
      // Run again, the frame replaces itself and does not grow.
      const again = await withContent(f, async () => (await session(f))({ ...turn(skills)[0], systemPrompt: asked.systemPrompt }, turn(skills)[1]));
      assert.equal(again.systemPrompt, asked.systemPrompt);
    }
  } finally {
    removeTestTree(f.base, "#219 session prompt");
  }
});

test("⚠️ #219 only the runtime's marker makes a process a child, and only a non-empty one", () => {
  assert.equal(isDelegatedChild({ [NONCE_ENV]: "0f".repeat(16) }), true);
  assert.equal(isDelegatedChild({ [NONCE_ENV]: "x" }), true);
  for (const env of [{}, { [NONCE_ENV]: "" }, { [NONCE_ENV]: undefined }, { KILN_ATTEST_FD: "3" }, { kiln_task_nonce: "0f" }, null, undefined])
    assert.equal(isDelegatedChild(env === undefined ? {} : env), false, JSON.stringify(env));
});
