/**
 * The probe extension, and the rules that make its observations mean anything.
 *
 * Two rules, both learned here the hard way:
 *   1. Take the mechanical observable UPSTREAM of the model. The marker is written when the module
 *      loads — before `session_start`, long before inference — so "the package loaded" never
 *      depends on what a model said.
 *   2. Negative evidence needs proof the observation point was reached. Every run records its exit
 *      status and output sizes, and every table has a row where the marker DOES appear.
 */

/** The extension source, written into the consumer's package at build time. */
export const PROBE_EXTENSION = `
import { appendFileSync, writeFileSync } from "node:fs";

const marker = process.env.KILN_SPIKE_MARKER;
const report = process.env.KILN_SPIKE_REPORT;
const label = process.env.KILN_SPIKE_LABEL ?? "unlabelled";

// Load-time marker: presence means the extension loaded, absence means it never did.
if (marker) appendFileSync(marker, \`loaded \${label}\\n\`);

const out: any = { label, toolCalls: [] };
function flush() { if (report) writeFileSync(report, JSON.stringify(out, null, 2) + "\\n"); }

const OBSERVED_VARS = [
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PATH", "TEMP", "TMPDIR",
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "WINDIR",
];

const FORBIDDEN = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AZURE_OPENAI_API_KEY", "TAVILY_API_KEY",
];

export default function (pi: any) {
  pi.registerTool?.({
    name: "kiln_spike_probe",
    description: "Spike-only probe tool. Accepts a challenge and returns a fixed acknowledgement.",
    parameters: {
      type: "object",
      properties: { challenge: { type: "string" } },
      required: ["challenge"],
      additionalProperties: false,
    },
    // ⚠️ execute(toolCallId, params, signal, onUpdate, ctx) — params are the SECOND argument.
    // Reading the first yields the call id, and the probe then reports a null challenge against a
    // tool that was in fact called correctly. That cost a debugging cycle here.
    execute: async (_toolCallId: string, params: any) => {
      out.toolCalls.push({ challenge: params?.challenge ?? null });
      flush();
      return { output: "KILN-PROBE-ACK" };
    },
  });

  pi.on("session_start", async () => {
    try { out.activeTools = pi.getActiveTools?.() ?? null; } catch {}
    try {
      out.allTools = (pi.getAllTools?.() ?? []).map((t: any) => t.name).sort();
    } catch {}
    // Names and presence only — never a value, on any path.
    out.varsPresent = Object.fromEntries(OBSERVED_VARS.map((n) => [n, process.env[n] !== undefined]));
    out.forbiddenPresent = FORBIDDEN.filter((n) => process.env[n] !== undefined).sort();
    out.sentinelsVisible = Object.keys(process.env).filter((k) => k.startsWith("KILN_SENTINEL_")).sort();
    out.envVarCount = Object.keys(process.env).length;
    out.envVarNames = Object.keys(process.env).sort();
    out.cwd = process.cwd();
    flush();
  });

  // Loaded-skill provenance is only visible here, and this fires only once a model turn begins.
  pi.on("before_agent_start", async (event: any) => {
    const spo = event?.systemPromptOptions ?? null;
    out.systemPromptOptionsSeen = Boolean(spo);
    out.skills = (spo?.skills ?? []).map((s: any) => ({ name: s.name ?? null, filePath: s.filePath ?? null }));
    flush();
  });
}
`;

/**
 * The negative-evidence gate. A run's observations are only admissible if the process actually got
 * far enough to make them.
 *
 * ⚠️ "TERMINATED AND SAID SOMETHING" IS NOT FAR ENOUGH, and the first version of this accepted
 * exactly that. A CLI that dies on an unparseable argument writes to stderr and exits — under the
 * old rule its missing marker read as a trust result. The marker is written when the extension
 * MODULE LOADS, and the session event is emitted after that point, so a session event in the
 * transcript is proof the process got past the place where the marker would have appeared.
 * An absent marker beside a present session event is a real negative; an absent marker beside no
 * session event is a void run.
 */
export function reachedObservationPoint(run) {
  if (run.status === null) return false; // killed or timed out
  return (run.events ?? []).some((e) => e?.type === "session");
}
