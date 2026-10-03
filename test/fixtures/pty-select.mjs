import { createClackRenderer } from "../../lib/setup-renderer-clack.mjs";

const renderer = createClackRenderer();
const selected = await renderer.select({
  message: "Choose a setup path",
  options: [
    { value: "alpha", label: "Alpha path" },
    { value: "beta", label: "Beta path" },
  ],
});
if (selected === null) {
  renderer.cancel("Fixture cancelled");
  console.log("RESULT:CANCELLED");
} else {
  renderer.complete(`Selected ${selected}`);
  console.log(`RESULT:${selected}`);
}
