# Handoff package

**Generated. Nothing here was written by hand**, and editing it edits a rendering — the next
`npm run handoff` overwrites you. Change `planning-content/` instead.

- snapshot: `53de6b88d6b6a1cf`
- tool version: `0.0.0`

## What is in it

- 36 acceptance-criterions
- 39 assertions
- 20 components
- 24 decisions
- 69 evidences
- 24 questions
- 21 requirements
- 1 runbook-step
- 17 tasks

## How to read it

- `data/*.json` is canonical and is what an automated consumer should read.
- `docs/*.md` is the same material for a human reading in the repository.
- `PLAN.md` is everything in one file, for dropping into a single context window.

⚠️ **Assertions carry a `derived` block** holding verdict and confidence. Those are computed from the
evidence graph at render time and are not stored on the artifacts — if you change the evidence, they
change. Nothing in this package asserts a confidence anyone typed.
