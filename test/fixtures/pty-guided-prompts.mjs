import { createClackRenderer } from "../../lib/setup-renderer-clack.mjs";
import { liveCheckRequest } from "../../lib/live-canary.mjs";

const renderer = createClackRenderer();
if (process.argv[2] === "secret") {
  const value = await renderer.secret({
    type: "connection:openai-source:credential-secret",
    message: "OpenAI API key",
    required: true,
  });
  console.log(`RESULT:${value === process.env.KILN_PTY_SECRET ? "MATCH" : "MISMATCH"}`);
} else if (process.argv[2] === "confirm") {
  const value = await renderer.confirm("Run one live model check now?");
  console.log(`RESULT:${String(value)}`);
} else if (process.argv[2] === "live-check") {
  const value = await renderer.ask(liveCheckRequest({ displayName: "OpenAI Codex", model: "gpt-6-sol" }));
  console.log(`RESULT:${String(value)}`);
} else {
  process.exitCode = 2;
}
