import { createClackRenderer } from "../../lib/setup-renderer-clack.mjs";

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
} else {
  process.exitCode = 2;
}
