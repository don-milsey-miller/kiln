# Stage 5 — Solution Design

> **Status: AGENT PROPOSAL, awaiting PM decisions.** Stage 5 is `decidedBy: Planning agent → user
> approves` (`stages/05-solution-design.json`). Nothing below is decided.
>
> **Run 2026-08-22 for a specific purpose:** step 6 is *"broaden the catalogue"*, and #106 says a type
> is built when authentic work demands it, never because a list names it. So this stage was run
> **against the 14 active requirements and the code that actually exists**, to find out which design
> outputs the existing artifacts cannot carry.
>
> ⚠️ **It is a real run, not a reconstruction** — unlike `03-discovery.md`. Its exit criteria are
> attestable in principle; two are attested below and one is deliberately not.

---

## 1. Requirements traced to components

**The components are the modules that exist.** This is the third exit criterion — *all requirements
trace to a component* — evaluated against the repository rather than against a diagram.

| | Requirement | Component(s) |
|---|---|---|
| REQ-0001 | process defined by the system | `stages/*.json` · `lib/stages.mjs` · `lib/lint.mjs` (gates) |
| REQ-0002 | state inspectable at any time | `lib/lint.mjs` · `bin/lint-plan.mjs` · `app/server.mjs` · `lib/view/assertion-view.mjs` |
| REQ-0003 | answerable from external sources | `lib/research/*` · `bin/research.mjs` |
| REQ-0004 | a claim records its source | `schemas/evidence.schema.json` (`sources`) · `lib/research/quote.mjs` |
| REQ-0005 | claims testable by execution | `lib/validation/controller.mjs` · `job.mjs` · `collectors.mjs` · `tools.mjs` |
| REQ-0006 | a tested claim records its environment | `schemas/evidence.schema.json` (`environment`) · `lib/validation/collectors.mjs` |
| REQ-0007 | every claim carries how it is known | `lib/effective-assertion.mjs` |
| REQ-0008 | claim strength readable without prose | `lib/effective-assertion.mjs` · `lib/view/assertion-view.mjs` |
| REQ-0009 | instructions rest on resolved claims | `lib/lint.mjs` · `lib/effective-assertion.mjs` (`mayBecomeInstruction`) |
| REQ-0010 | handoff actionable without returning | ❌ **no component** |
| REQ-0011 | serves a human OR an agent | ⚠️ **half** — `lib/view/assertion-view.mjs` · `app/server.mjs`; nothing exports |
| REQ-0012 | costly validation needs authorisation | `lib/validation/job.mjs` (ceiling, refusal before provisioning) · `lib/specialists/contract.mjs` |
| REQ-0013 | decisions recorded with alternatives | `schemas/decision.schema.json` · `lib/tools/evidence-tools.mjs` |
| REQ-0014 | questions tracked as objects | `schemas/question.schema.json` · `resolveQuestion` |

**Twelve of fourteen trace to a component. REQ-0010 has none, and REQ-0011 has half.** Both are the
handoff, and both are held by `QST-0007`, which waits on handoff design.

⚠️ **This table is what the criterion asks for and it is not an artifact.** That is the finding in
§3.

## 2. Storage and data model

**Storage target: one JSON file per artifact under `planning-content/data/<type>s/`, plus
`state/` for attestations.** Already chosen and in use (#87), reached through `lib/layout.mjs`,
`lib/content-root.mjs` and `lib/atomic-write.mjs`, serialised by `lib/lock.mjs`.

**Data model: `schemas/*.schema.json`** — nine files, composed through
`common.schema.json#/$defs/artifactEnvelope`, resolved by `lib/schema-resolver.mjs`.

⚠️ **Both are decided and running. Stage 5 is confirming them, not choosing them** — which is itself a
finding about running stages out of order, and an honest one: this project built its substrate before
it ran the stage that is supposed to design it.

## 3. What stage 5 produced that existing artifacts cannot carry

Stage 5 declares `produces: [schema, api-spec, wireframe]`. **Running it produced demand for none of
those three, and clear demand for one type that is not in #38's sixteen at all.**

### ✅ Candidate: `component` — passes #41

| #41's test | Answer |
|---|---|
| **Irreducible state it owns** | A named unit of the design, its responsibility, and **which requirements it satisfies**. Nothing else holds this. The requirement cannot: a requirement is what must be true, not what implements it, and one component satisfies many requirements while one requirement needs several. |
| **Consumer that must traverse it** | **Four, all already decided.** #60's cascade uses `acceptance-criterion → component` as its worked example. #19's role slicing slices over components. The **stage-9 completeness gate** flags *"a requirement no component satisfies"* — an orphan check that needs the edge to exist. And **this stage's own third exit criterion** is unevaluable without it. |

⚠️ **The traceability chain in `notes.md` names it three times** — *requirement (2) → design component
(5) → assertion + evidence → acceptance criterion (7) → task (8) → runbook step (9)* — and #38's
sixteen types **do not include it**. So the chain four decisions depend on has a **missing link**, and
nobody noticed because nothing had run stage 5.

⚠️ **The honest counter-arguments, applied rather than skipped.** *Could the edge live on the
requirement as a string?* That is #85's rejected prose-assumption in a different costume: a string
cannot be traced, counted or flagged, and the orphan check needs traversal. *Could a component be
prose in an architecture doc?* Same failure — §1 above is exactly that prose, and it cannot be linted.
*Could it be a `scope-boundary`?* No: a scope boundary says what is out, not what implements what.

### ❌ `schema` — demand is weaker than the catalogue implies

The data model exists as JSON Schema files, and they are **already consumed directly** by
`lib/validate.mjs`, `lib/schema-resolver.mjs`, `lib/template.mjs` and the lint. A `schema` artifact
under #8's dual-representation rule would carry an envelope and a `payloadRef` to the file — **so what
would it add?** Only trace edges: *this requirement is served by that schema*. **That is the
`component` edge again**, and a `component` pointing at `schemas/evidence.schema.json` says it without
a second type.

⚠️ **Not a refusal — a deferral with a condition:** `schema` earns itself when a **consumer project**
designs a data model that is not the planning schema itself. This project never asked for one (#95:
activation governs whether a project may author a type, not whether the tool supports it).

### ❌ `api-spec` — the interface already exists as data, and is already traversed

This project's real interface contracts are `RESEARCH_TOOL_SIGNATURES` and
`VALIDATION_TOOL_SIGNATURES`. They are **machine-readable, versioned with the code, and traversed by
`lib/specialists/contract.mjs` and #81's signature check** — and #138 made copying them into a second
document the specific defect it fixed. **Modelling them as artifacts would re-create that defect by
design.**

### ❌ `wireframe` — blocked behind an undecided commitment, not undecided itself

`QST-0008` asks whether the skeleton's rendering is sufficient for REQ-0011's human half. **A wireframe
is a design for a UI nobody has committed to building.** Producing one now would be the same error as
running `AST-0010`'s experiment (#137): designing for an undeclared scope.

---

## 4. What this says about the draft methodology

⚠️ **Stage 5's `produces` list is wrong for this project, and that is evidence rather than an
obligation.** It names three types; authentic work demanded **none of them** and demanded one the
catalogue lacks. Under #90 the stage definition is **authoritative**, so the gate will keep reporting
`gate/type-not-implemented` for `schema`, `api-spec` and `wireframe` — **and that finding is accurate.**
Under #91 it is **not correct**, and this run is the first evidence about it.

**The pattern now has two instances.** Stage 3 declared `research-finding` and the work needed none
(#136). Stage 5 declares three types and the work needed none of them. ⚠️ **Two stages disagreeing
with the draft table is not yet proof the table is wrong** — this project is one project, and its
intake asked for a planning system rather than a product with a UI and an API. **A consumer project
designing a real service would plausibly need all three.** What it does show is that
`produces[]` describes **a project type**, not a stage, and the table was transcribed as though it
described a stage.

---

## 5. Exit criteria

| Criterion | Attestation | Why |
|---|---|---|
| **storage-target-chosen** | ✅ `satisfied` | One JSON file per artifact under `planning-content/data/`, atomic writes under a lockfile. Chosen (#87), implemented, and in use by 67 artifacts. |
| **data-model-approved** | ✅ `satisfied` | Nine schemas, composed through one envelope, resolved by one layer, exercised by 199 tests. |
| **requirements-traced-to-components** | ❌ `not-satisfied` | **REQ-0010 traces to no component and REQ-0011 to half of one.** ⚠️ And the trace itself is **prose in §1**, not artifacts — the criterion asks for something the catalogue cannot yet express. Recorded `not-satisfied` rather than left unevaluated: someone looked and said no (#93). |

⚠️ **The third criterion is not blocked by missing work — it is blocked by a missing TYPE**, which is
the first time a stage's own exit criterion has produced demand for a catalogue addition. That is
exactly what step 6 was reordered to wait for.
