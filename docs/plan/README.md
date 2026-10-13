# Handoff package

**Generated. Nothing here was written by hand**, and editing it edits a rendering — the next
`npm run handoff` overwrites you. Change `planning-content/` instead.

- snapshot: `6c31f5222c73dc56`
- tool version: `26.10.0`

## What is in it

- 120 acceptance-criterions
- 53 assertions
- 41 components
- 33 decisions
- 156 evidences
- 33 questions
- 28 requirements
- 1 runbook-step
- 75 tasks

## How to read it

- `data/*.json` is canonical and is what an automated consumer should read.
- `docs/*.md` is the same material for a human reading in the repository.
- `PLAN.md` is everything in one file, for dropping into a single context window.

⚠️ **Assertions carry a `derived` block** holding verdict and confidence. Those are computed from the
evidence graph at render time and are not stored on the artifacts — if you change the evidence, they
change. Nothing in this package asserts a confidence anyone typed.
