# The handoff package — contract

> ⚠️ **This file is AUTHORED and lives OUTSIDE `docs/plan/`.** It used to be `docs/plan/README.md`,
> which was a contradiction: that directory is replaced wholesale by `npm run handoff`, so authored
> content inside it would be deleted by the first successful run. Moved 2026-08-22 (#142).
>
> **`docs/plan/` is generated in its entirety and contains nothing anyone wrote by hand.**

## The delivery channel

The folder in the repo *is* the delivery. It is present the moment anyone clones, with zero
infrastructure — no server, no URL to keep alive, no MCP endpoint to run. `PLAN.md` is the
bundled-file option thrown in for free, for whoever wants to drop the whole plan into one context
window.

## Shape (v1)

```
docs/plan/
├── README.md            ← generated: what this package is, and what produced it
├── MANIFEST.json        ← generated: snapshot identity, counts, tool version
├── data/                ← agents. canonical.
│   ├── requirements.json  components.json  decisions.json
│   ├── assertions.json    ← claims + DERIVED verdict and confidence + evidence refs
│   ├── evidence.json      ← observations, environments, omissions
│   ├── questions.json     ← including the unresolved ones and what they block
│   └── runbook-steps.json ← steps, with what each rests on
├── docs/                ← humans reading in the repo (renderable anywhere)
│   └── 01-intake.md … 09-handoff.md
└── PLAN.md              ← single-file context bundle
```

⚠️ **What is deliberately NOT here, and why:**

- **No `site/`.** `DEC-0010`: the delivery surfaces are canonical JSON for agents and generated
  Markdown for humans. An interactive site requires **separately demonstrated demand**. The authoring
  skeleton is not the delivery surface — it shows *current* state, and a handoff must show *approved*
  state.
- **No aggregate `runbook.json`.** `DEC-0011` does not retain the `runbook` type for v1. Steps ship;
  membership reverses `partOf` and ordering is `ordinal` + `dependsOn`, so the aggregate is a
  projection nothing needs to store.
- **No per-role slices.** They move to stage 8, where the task graph they query exists. `task` and
  `role-assignment` are unbuilt, so a slice today would filter an empty graph. **The slice-is-a-query
  design survives; only its timing was wrong** (#19, amended).
- **Only ACTIVATED content.** The package renders the types this project activated. A deactivated
  type is absent rather than empty, because an empty file implies the question was asked and answered
  "none".

Ship the data as canonical, ship a rendering per audience. **MDX never leaves the planning app** — it
is an authoring format, not a delivery format.

## The publish gate

⚠️ **`npm run handoff` refuses unless the project is genuinely ready, and "clean lint" is not that
test.** A project can lint clean while a stage gate is explicitly `not-satisfied` — this repo is in
exactly that state today, with stage 5's `requirements-traced-to-components` attested `not-satisfied`
because REQ-0010 traces only to a *planned* component.

So completeness includes the **stage attestations**, not only artifact validity:

1. every artifact valid, no blocking lint findings;
2. every stage that declares exit criteria has them **attested**, and none attested `not-satisfied`;
3. re-evaluated **immediately before** snapshotting — never a cached result from an earlier command.

**A refusal writes nothing.** The previous package survives untouched, because a half-replaced
handoff is worse than a stale one: a stale package is wrong in a way its own MANIFEST reveals, and a
half-replaced one is wrong in a way nothing reveals.

## Determinism

**Two runs over identical content and an identical tool version produce byte-identical output.**
That is what makes the package reviewable in a diff: a change in the diff means a change in the plan,
never a change in the clock. Consequently the package contains **no wall-clock timestamps** — its
identity is a **content hash of the canonical input**, which is both deterministic and a genuine
version identifier.

## Why evidence ships with the plan

A runbook step that says "install via method B" is worth much less than one that also says: method A
failed on RHEL 10, here is the output; method B succeeded, here is the output; the test environment
matched on OS and package manager but not GPU family. The second one lets the executing team reason
when reality diverges. Shipping conclusions without evidence is how a plan becomes something you
either obey or abandon.

---

*Decisions referenced as `#n` are rows in `references/notes-transcriptions/notes.md`, which stays
canonical.*
