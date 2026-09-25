#!/usr/bin/env node
/**
 * ACC-0114's retained record: the first user-visible Stage 1 turn of a fresh project started with `/kiln-start` against
 * a real configured model, written out for a person to judge — TSK-0063.
 *
 *   node .planning/tools/acc-0114/first-turn-record.mjs [--project <dir>] [--session <file.jsonl>] [--out <dir>]
 *
 * ⚠️ **THIS RECORDS; IT DOES NOT JUDGE.** Whether the turn asks exactly one question, proposes no architecture,
 * requirement set or solution, and calls no mutating tool is the reviewer's verdict against this record, not this
 * script's and not the model's. Every tool call is listed with its arguments so the reviewer can see what it did; the
 * verdict fields are written empty.
 *
 * ⚠️ **IT REFUSES A RECORD THAT WOULD NOT BE THE TURN THE CRITERION IS ABOUT.** The session's first user message must be
 * Pi's own expansion of `/kiln-start`, byte for byte, and the turn must have ended (the model stopped rather than being
 * cut off). Anything else exits 2 and writes nothing.
 *
 * The session is Pi's own transcript: `<project>/.pi/sessions/*_<id>.jsonl` for the id in `.pi/runtime/kiln-session.json`,
 * or the file given with `--session` (external state mode keeps sessions elsewhere).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePinnedSdk } from "../../lib/pi-runtime.mjs";

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The most of one tool result kept in the record; the full result stays in Pi's transcript. */
const RESULT_CHARS = 4000;

export class RecordRefusal extends Error {}

/** The first turn after Pi's expansion of /kiln-start, from a session's entries. */
export function firstTurn(entries, startBody) {
  const messages = entries.filter((e) => e.type === "message" && e.message);
  const firstUser = messages.findIndex((e) => e.message.role === "user");
  if (firstUser < 0) throw new RecordRefusal("the session has no user message: it was never started");
  const opening = (messages[firstUser].message.content ?? []).map((c) => c.text ?? "").join("");
  if (opening !== startBody)
    throw new RecordRefusal("the session did not open with Pi's own expansion of /kiln-start, so it is not the turn ACC-0114 is about");
  const rest = messages.slice(firstUser + 1);
  const end = rest.findIndex((e) => e.message.role === "user");
  const turn = end < 0 ? rest : rest.slice(0, end);
  const assistants = turn.filter((e) => e.message.role === "assistant");
  const last = assistants.at(-1)?.message;
  if (!last) throw new RecordRefusal("the model never answered the start prompt");
  if (last.stopReason !== "stop")
    throw new RecordRefusal(`the first turn did not end on its own (last stop reason: ${last.stopReason ?? "none"}); let it finish, then quit`);

  const steps = [];
  for (const e of turn) {
    const m = e.message;
    if (m.role === "assistant")
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text) steps.push({ kind: "text", at: e.timestamp, text: c.text });
        else if (c.type === "toolCall") steps.push({ kind: "toolCall", at: e.timestamp, id: c.id, name: c.name, arguments: c.arguments ?? {} });
      }
    else if (m.role === "toolResult") {
      const text = (m.content ?? []).map((c) => c.text ?? "").join("");
      steps.push({ kind: "toolResult", at: e.timestamp, toolCallId: m.toolCallId, name: m.toolName, isError: m.isError === true, text: text.slice(0, RESULT_CHARS), truncated: text.length > RESULT_CHARS });
    }
  }
  return {
    provider: last.provider ?? null,
    model: last.model ?? null,
    startedAt: messages[firstUser].timestamp,
    endedAt: assistants.at(-1).timestamp,
    steps,
    visibleText: steps.filter((s) => s.kind === "text").map((s) => s.text).join("\n\n"),
    toolCalls: steps.filter((s) => s.kind === "toolCall").map(({ name, arguments: args }) => ({ name, arguments: args })),
  };
}

/** The reviewer's copy: the visible text verbatim, the tool calls, and the three questions left for a person. */
export function markdown(record) {
  const fence = "````";
  const lines = [
    `# ACC-0114 first Stage 1 turn — ${record.sessionId}`,
    "",
    `Model: ${record.turn.provider} ${record.turn.model} · turn ${record.turn.startedAt} to ${record.turn.endedAt} · recorded ${record.recordedAt}`,
    `Session file: ${record.sessionFile}`,
    "",
    "## What the operator saw",
    "",
    fence,
    record.turn.visibleText,
    fence,
    "",
    "## Tool calls, in order",
    "",
    ...(record.turn.toolCalls.length ? record.turn.toolCalls.map((t, i) => `${i + 1}. \`${t.name}\` ${JSON.stringify(t.arguments)}`) : ["None."]),
    "",
    "Each call's result is in the JSON record beside this file.",
    "",
    "## Verdict — for a person, against this record",
    "",
    "- [ ] The turn asks exactly one question.",
    "- [ ] It proposes no architecture, no requirement set and no solution.",
    "- [ ] It calls no tool that creates, revises, links or otherwise changes planning content.",
    "",
    "Reviewer: ______  Date: ______  Notes:",
    "",
  ];
  return lines.join("\n");
}

function sessionFileFor(project) {
  const pointer = join(project, ".pi", "runtime", "kiln-session.json");
  if (!existsSync(pointer)) throw new RecordRefusal(`no recorded Kiln session at ${pointer}; pass --session <file.jsonl>`);
  const { sessionId } = JSON.parse(readFileSync(pointer, "utf-8"));
  const dir = join(project, ".pi", "sessions");
  const match = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(`_${sessionId}.jsonl`)) : [];
  if (match.length !== 1) throw new RecordRefusal(`expected one transcript for session ${sessionId} in ${dir}, found ${match.length}; pass --session <file.jsonl>`);
  return join(dir, match[0]);
}

export async function record({ project, session = null, out = null, now = () => new Date() }) {
  const sessionFile = session ?? sessionFileFor(project);
  const entries = readFileSync(sessionFile, "utf-8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const header = entries.find((e) => e.type === "session");
  const sdk = await import(resolvePinnedSdk(TOOL_ROOT).url);
  const startBody = sdk.parseFrontmatter(readFileSync(join(TOOL_ROOT, "pi-package", "prompts", "kiln-start.md"), "utf8")).body;
  const turn = firstTurn(entries, startBody);
  const result = { recordVersion: 1, criterion: "ACC-0114", recordedAt: now().toISOString(), sessionId: header?.id ?? null, sessionFile, turn, verdict: { oneQuestion: null, noSolution: null, noMutatingTool: null, reviewer: null, reviewedAt: null, notes: null } };
  const dir = out ?? project;
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `acc-0114-first-turn-${result.sessionId}`);
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(`${base}.md`, markdown(result));
  return { result, files: [`${base}.json`, `${base}.md`] };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  try {
    const { files } = await record({ project: resolve(opt("--project") ?? process.cwd()), session: opt("--session"), out: opt("--out") });
    for (const f of files) console.log(`[acc-0114] wrote ${f}`);
  } catch (e) {
    if (!(e instanceof RecordRefusal)) throw e;
    console.error(`[acc-0114] ${e.message}. Nothing was written.`);
    process.exit(2);
  }
}
