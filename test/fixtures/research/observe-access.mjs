// Preloaded into a research CLI under test (F4, ACC-0120): records whether TAVILY_API_KEY was read and whether any
// request was attempted, and refuses the request, so a refusal can be shown to come before both.
import { appendFileSync } from "node:fs";

const out = process.env.KILN_ACCESS_OUT;
const note = (what) => out && appendFileSync(out, `${what}\n`);
const real = process.env;
process.env = new Proxy(real, {
  get(target, key) {
    if (typeof key === "string" && key.toUpperCase() === "TAVILY_API_KEY") note("key-read");
    return Reflect.get(target, key);
  },
});
globalThis.fetch = async (url) => {
  note(`request ${String(url)}`);
  throw new Error("network refused by the test");
};
