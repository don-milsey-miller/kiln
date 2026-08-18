# Stage 2 — Intent Decomposition

> **Status: PM-APPROVED.** Stage 2 is
> `decidedBy: agent-proposes-user-confirms` (#34, #39). The proposal below is now confirmed with the
> corrections and explicit activation decision recorded in this document.
>
> Derived from `01-intake.md` **only**. Deliberately not from the architecture, and deliberately not
> from step 3's four artifact types — checking whether the methodology independently produces what the
> architecture had already assumed is the whole point of running this stage for real (#91).

---

## Requirements

**15 `requirement` artifacts, written by the typed tool** into `data/requirements/REQ-0001…REQ-0015`.
They are real artifacts, not a list in a document. PM review left 14 active and retired REQ-0015 after
finding that its local/single-operator constraint had been back-projected from the architecture into
the intake.

| ID | Requirement | Priority | From |
|---|---|---|---|
| REQ-0001 | The planning process is defined by the system, not by the session | must | "session quality is inconsistent" |
| REQ-0002 | Current project state is inspectable at any time | must | same |
| REQ-0003 | Implementation questions can be answered from current external sources | must | problem 2, "educated guessing" |
| REQ-0004 | A claim taken from a source records that source | must | problem 2 |
| REQ-0005 | Claims can be tested by execution in a real environment | must | problem 3, no sandbox |
| REQ-0006 | A tested claim records the environment it was tested in | must | problem 3 |
| REQ-0007 | Every load-bearing claim carries how it is known | must | the central constraint |
| REQ-0008 | A reader can distinguish claim strength without reading prose | must | the central constraint |
| REQ-0009 | Instructions rest on resolved claims | must | "the runbook is the output of discovery" |
| REQ-0010 | The handoff is actionable without returning to the planner | must | objective |
| REQ-0011 | The output serves a human or an agent implementer | must | stakeholders; sharpened during PM review to compare both against one required-information inventory |
| REQ-0012 | Validation that costs money or needs credentials requires explicit authorisation | must | constraints |
| REQ-0013 | Decisions are recorded with their alternatives | should | "capture decisions" |
| REQ-0014 | Open questions are tracked objects, not prose | should | "capture decisions" |
| REQ-0015 | The system runs locally for a single operator | retired | removed from intake: later architecture choice, not a frozen-source constraint |

## Explicit non-goals

Carried from intake unchanged, because the source material states all four as future ambitions:
executing the plan · monitoring or supervising execution · learning from production outcomes · any
organisation-wide knowledge system.

⚠️ Held as **prose**, not as artifacts. `scope-boundary` is not activated, and #92 records why the stage
definition does not demand it: the settled table names *"explicit non-goals"* as an **output**, not as an
artifact type.

## Glossary

| Term | As used here |
|---|---|
| **Claim** | A statement the plan depends on being true. |
| **Basis** | How a claim is known: unverified, source-supported, or demonstrated by execution. |
| **Load-bearing** | A claim whose falsity would change the plan. |
| **Instruction** | A step in the output that someone will actually run. |
| **Handoff** | What the recipient receives and acts on. |

---

## Artifact type activation — the proposal, and the finding

**Method:** for each of the 15 requirements, ask what structured object the requirement implies. Nothing
was taken from the existing architecture.

| Type | Called for by | Verdict |
|---|---|---|
| `requirement` | the stage itself | **activate — approved** |
| `assertion` | REQ-0004, 0007, 0008, 0009 | **activate — approved** |
| `evidence` | REQ-0004, 0005, 0006, 0008 | **activate — approved** |
| `research-finding` | REQ-0003 | **activate — approved** |
| `decision` | REQ-0013 | **activate — approved** |
| `question` | REQ-0014 | **activate — approved** |
| `runbook`, `runbook-step` | REQ-0009, REQ-0010 | **activate — approved** |
| `acceptance-criterion` | nothing directly; implied by REQ-0010 | propose, weakly |
| `task` | nothing directly | defer |
| `risk` | nothing in the intake | defer |
| `schema`, `api-spec`, `wireframe` | **nothing** | **do not activate yet** |
| `scope-boundary`, `role-assignment` | nothing directly | defer |

### ⚠️ The finding, and it disagrees with a prior assumption

> **Stage 2, run honestly against the intake, does not produce step 3's four types.**
> It produces `requirement` and `decision` — and then `assertion`, `evidence`, `research-finding`,
> `question`, `runbook`, `runbook-step`. **`schema` and `api-spec` are not called for by a single one of
> the fifteen requirements.**

This is evidence, not a failed exercise (#91). Three things follow:

1. **`schema` and `api-spec` are stage-5 outputs of a project that has a data model and an API.** They
   describe *the product being planned*, and this intake never asks for one. They were chosen in step 3
   as a **testbed for the shared conventions**, which is a legitimate reason to have built them — but it
   is not the same as the methodology asking for them, and the two had not been distinguished.

2. **Seven of fifteen requirements point at the evidence loop.** REQ-0004 through REQ-0009 are almost
   entirely `assertion` and `evidence`. The methodology, run on the PM's own words, says the evidence
   loop is not a later phase — **it is most of what was asked for.** That is independent corroboration of
   the review document's argument for pulling the evidence slice earlier, arrived at from the intake
   rather than from the architecture.

3. **The activation list the architecture assumed and the one stage 2 produces overlap in two places out
   of eight.** Recording that is the point of having run this.

---

## Exit criteria — PM attestation required (#93)

Three criteria, all `mechanised: false`. Each needs `satisfied` / `not-satisfied` / `n/a` **with a
reason** — an evaluation, not an acknowledgement.

| Criterion | Agent's input to the PM's judgement |
|---|---|
| `every-requirement-testable` | **Satisfied.** All 14 active requirements state observable conditions; REQ-0011 was sharpened during review. REQ-0015 is retired and no longer claims intake provenance. |
| `scope-boundary-drawn` | **Satisfied.** The corrected intake distinguishes the current through-handoff boundary from the broader frozen-source ambitions. Prose is sufficient because no downstream mechanism currently traverses individual non-goals. |
| `type-activation-approved` | **Satisfied.** The PM approves the eight strongly-derived types: `requirement`, `decision`, `assertion`, `evidence`, `research-finding`, `question`, `runbook`, and `runbook-step`. The weak `acceptance-criterion` inference and all deferred types remain inactive. |

**The approved set is recorded in `project.yaml`.** This approval deliberately does not activate
`schema` or `api-spec`: their implementation remains useful shared-infrastructure work, but this
project's intake does not call for those artifact types.
