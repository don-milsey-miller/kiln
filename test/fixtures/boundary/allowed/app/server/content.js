// Fixture adapter. No `import "server-only"` here on purpose: everything under test/ is
// collected by `node --test`, and the marker THROWS outside the RSC compiler (AST-0033) — a
// fixture that crashed on collection would fail the suite for a reason unrelated to what it tests.
// The guard is checked separately, against the real app/server/ directory, by ACC-0025.
export { readIt } from "../../lib/thing.mjs";
