import { createPlainRenderer } from "../../lib/setup-renderer-plain.mjs";

const renderer = createPlainRenderer();
const answer = await renderer.ask("Fixture answer: ");
console.log(`RESULT:${answer === null ? "CANCELLED" : answer}`);
