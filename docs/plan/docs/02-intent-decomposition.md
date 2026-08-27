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

---

# Second decomposition — the application shell (2026-08-24)

> **Status: PM-CONFIRMED 2026-08-24.** Stage 2 is `decidedBy: agent-proposes-user-confirms` (#34, #39).
> The agent proposed the scope below and **the PM confirmed it as written, without amendment** — the
> five requirements judged testable, the first-slice boundary judged appropriately narrow, and the
> deferral of tasks until acceptance criteria exist judged correct. It decomposes a **new ask** — the
> Next.js/MDX application — into requirements and open questions, and draws the scope boundary. It
> does not design the application; that is stage 5, and stage 5 has not run for it.
>
> ⚠️ **This is a second decomposition, not a revision of the first.** The 15 requirements above came
> from the frozen intake and still stand unchanged; these five come from a later ask, and mixing them
> would lose which requirements this project was founded on. #14 honours a determined stage set — it
> does not say a stage runs once.

## The ask

A local Next.js application that **displays the current project stage and an MDX stage document,
reflects external file changes through the existing watcher/SSE contract, and performs review-status
updates through the existing typed write path.** One vertical slice, end to end.

⚠️ **The system is ready to PLAN this and is not ready to build it broadly.** Product-facing
requirements, acceptance criteria and tasks do not exist for the application, and #5's Next.js/MDX
choice has never been exercised — `app/server.mjs` is the walking skeleton (5b) and says so in its own
header. What follows is intake and scope, not implementation.

## Scope boundary

| In scope for the first slice | Out of scope, and why |
|---|---|
| Current stage display, derived (#16) | Authoring UI — no requirement asks for it yet, and #43 makes templates generated |
| One MDX stage document rendered | Navigation across all nine stages — an IA question (`QST-0019`) precedes it |
| External-change refresh via watcher + SSE | Full artifact tracker and assertion/evidence views — `app/server.mjs` already renders the second |
| Review-status write through the typed path | Any second write path into content (#88) |
| A stated, documented deployment mode | Consumer packaging — step 6, and it depends on the mode answer |

## Five open questions, authored as artifacts (REQ-0014)

| ID | Question | Why it gates the slice |
|---|---|---|
| `QST-0017` | `next dev` only, or `next build` / `next start`? | ⚠️ **A trigger, not only a choice.** `AST-0010` is deferred (#137) *because* the deployment mode is undeclared. Answering "production" reopens that validation the moment it is answered. |
| `QST-0018` | How is MDX compiled, and what may a document execute? | Stage documents are agent-authored. MDX compiles to JavaScript, so a permissive default makes content into arbitrary application code — the inverse of #88. |
| `QST-0019` | What is the initial information architecture? | Decides what the slice renders and what it defers. |
| `QST-0020` | How does the shell import `lib/` without duplicating it? | #47 has one implementation and several callers. The hard part is that these modules are Node-only — the server/client boundary is the real question. |
| `QST-0021` | Install, startup, watcher lifetime, SSE reconnect, errors? | Each has a partial answer in the skeleton and none is a written contract. A silently dead stream renders stale content that looks live. |

## Five requirements, and the decision that bounds them

| ID | Requirement | Open on |
|---|---|---|
| `REQ-0016` | The application displays the project's current stage | `QST-0019` |
| `REQ-0017` | The application renders a stage document authored in MDX | `QST-0018` |
| `REQ-0018` | The application reflects external content changes without a manual reload | `QST-0021` |
| `REQ-0019` | The application performs review-status updates through the existing typed write path | `QST-0020` |
| `REQ-0020` | The application is installable and runnable locally from a documented command | ~~`QST-0017`~~ answered, `QST-0021` |

⚠️ **A sixth was added on 2026-08-26, after the PM confirmed the five above.** It is listed separately
rather than folded into the confirmed table, because a table that grows silently stops recording what
was actually approved and when.

| ID | Requirement | Open on | Origin |
|---|---|---|---|
| `REQ-0021` | Planning-content reads are confined to the approved abstraction, and the confinement is checked **statically** | — | **Measurement, not decomposition** — `AST-0022` |

**It exists because a test cannot see the violation.** `AST-0022` measured that a read breaking the
`DEC-0019` contract is served **fresh** whenever a compliant read shares its route, so every
behavioural freshness check passes on a codebase that breaks the contract — until the compliant
sibling moves, and every read on that route silently reverts to build-time content. **A test that
passes on broken code is worse than no test, because it is also a claim that the code was checked.**
So the property has to be enforced where it is visible: in the source. ⚠️ The *mechanism* is
deliberately unspecified — that is stage 5 design work, and naming one here would decide it before the
components exist.

**`DEC-0017` — the Next.js shell reuses the substrate; the skeleton is not migrated.** `app/server.mjs`
stays as the **verified substrate reference** until the new shell reaches behavioural parity with its
seven proven properties, and the shell imports `lib/` rather than reimplementing any of it. Three
alternatives are recorded with why each lost, including the tempting one: migrating the skeleton
removes the only working reference at exactly the moment a second implementation appears.

## Roadmap, mapped to the stages that own each step

| Step | Stage | What settles it |
|---|---|---|
| 1. UI intake and scope boundaries | **1–2** | This section. Confirmation is the PM's. |
| 2. Targeted Next.js/MDX research; deployment-mode decision | **3** | The five questions, **in the order below**. Each claim recorded as an `assertion` with its `evidence` (REQ-0003, REQ-0004) |
| 3a. Component design | **5** | `component` artifacts; `requirements-traced-to-components` re-attested |
| 3b. Risk and feasibility | **6** | ⚠️ **Not skippable, and no longer conditional:** `QST-0017` answered production mode, so `AST-0010` HAS reopened and needs real validation here before anything rests on it |
| 3c. Acceptance criteria | **7** | External refresh · write-back safety · malformed content · stage-status accuracy |
| 4. One end-to-end vertical slice | **8** | `task` artifacts. ⚠️ **Deliberately not authored yet:** the handoff gate refuses a task with no acceptance criteria, so tasks cannot honestly precede step 3c |
| 5. Navigation, authoring, review, full tracker | later cycles | Real demand, per #106 |
| 6. Package the local application for consumers | later | Depends on the `QST-0017` answer |

## Research order for step 2 — PM-set 2026-08-24

Not arbitrary: each question removes options from the ones after it, so answering them out of order
means designing against constraints nobody has established yet and rediscovering them later.

| # | Question | Why here |
|---|---|---|
| 1 | ✅ `QST-0017` deployment mode | **Answered 2026-08-25 — `DEC-0018`: production mode (`next build` + `next start`); `next dev` is a contributor workflow only.** It was first because it is the only one that creates owed work, and it did: `AST-0010`'s reopening condition fired on BOTH clauses — production mode adopted, and 16.3.2 in play against a claim tested at 16.3.1 — so the validation is now **owed at step 3b** |
| 2 | `QST-0018` MDX compilation and component bound | The safety boundary on agent-authored content. Everything rendered later goes through whatever this settles |
| 3 | `QST-0020` server/client module boundary | `lib/` is Node-only — filesystem, locks, subprocesses. What may cross to the client constrains every view |
| 4 | `QST-0021` runtime lifecycle | Install, watcher lifetime, SSE recovery, and **visible** failure behaviour. Depends on 1 and 3 |
| 5 | `QST-0019` information architecture | ⚠️ **Answered last, and NOT by research.** Principally a product decision — no source settles which views a planning tool opens with. Decided under the constraints the first four establish |

**The first four need targeted technical research, and bounded probes where documentation is
insufficient** — REQ-0003 and REQ-0005 doing exactly what they were written for, and what the research
and tier-1 validation capabilities were built to serve.

## Stage 6 — ✅ re-attested 2026-08-25, and it now blocks too

`DEC-0018` reopened `AST-0010`, and **stage 6 is where an owed validation gets judged.** Its
attestations were recorded on 2026-08-22, against a plan with no application shell in it and with
`AST-0010` deferred rather than owed.

| Criterion | Re-attested | On what basis |
|---|---|---|
| `high-severity-risks-mitigated` | **`not-satisfied`** | The former basis predates the shell. `AST-0010` is a live production-build risk with **neither** experimental validation **nor** a mitigation — disabling Cache Components has not been chosen either. ⚠️ Not an accepted risk: #80's condition fired so the validation would arrive *with* the commitment needing it, and signing it off unvalidated would be that deferral wearing a different word |
| `load-bearing-assertions-at-rung` | `n/a` | Measured again, not carried forward: the scope is derived from *instructions resting on* assertions, and it is still **empty** — `RBS-0001` is retired and rests on `AST-0002`, so no active instruction rests on anything. ⚠️ `AST-0010` is deliberately **not** captured here; stretching a criterion to cover a risk it does not describe makes both harder to read |

⚠️ **Verified by re-running the gate, not assumed: stage 6 reports NOT READY**, and the handoff now
refuses on **two** blockers rather than one. Both are PM verdicts (#93) — the agent authored the
inputs and did not attest them.

⚠️ **AMENDED 2026-08-25 — that exit condition was wrong, and the validation is what showed it.** It
said satisfied returned on validation *or* an accepted-risk signoff. The validation happened
(`EVD-0022`) and **confirmed** the risk in both configurations, while removing the mitigation anyone
would have reached for first. And an accepted-risk signoff is not available: silently serving
build-time content does not make `REQ-0016`–`REQ-0018` riskier, it **violates** them — a risk you can
accept is one where the plan still holds if it lands.

**`high-severity-risks-mitigated` now returns to satisfied** when `QST-0023` produces a production-safe
design **and that design is validated**: an artifact-reading route measured to reflect an external
write under `next build` + `next start`. A mitigation that has not been run is a plan for one.

## Re-attestation — ✅ done 2026-08-24, and the handoff now refuses

Authoring `REQ-0016…REQ-0020` made **four** `satisfied` attestations semantically stale: they were
evaluated on 2026-08-22 against a plan that did not contain these requirements. This is #79 exactly —
staleness that is named and deliberately not solved mechanically, which makes it the PM's to
re-evaluate rather than the tool's to detect.

⚠️ **The gates reported READY throughout that window, and that was the finding rather than a
reassurance.** Every criterion here is `mechanised: false`, so nothing detected that four attestations
described a smaller plan than the one on disk. **Nothing was republished while that was true.**

| Stage | Criterion | Re-attested | On what basis |
|---|---|---|---|
| 2 | `every-requirement-testable` | `satisfied` | Each of the five states an observable condition. ⚠️ Testable ≠ specified: four depend on an open question, and this criterion asks whether a requirement *can* be tested |
| 2 | `scope-boundary-drawn` | `satisfied` | PM confirmation of the in/out table above, without amendment |
| 2 | `type-activation-approved` | `satisfied` | ⚠️ **The fourth, and it was stale for a different reason** — its previous text still named `runbook` and `research-finding`, both since deactivated. Re-stated against the current set, and **the shell needs no new type**: its requirements decompose into `component`, `acceptance-criterion` and `task`, all already activated (#106) |
| 5 | `requirements-traced-to-components` | **`not-satisfied`** | The five trace to no component, because stage 5 has not run for the shell |

### The handoff refuses, and the refusal is the correct state

`npm run handoff` now blocks on one criterion: stage 5's traceability. **That is not a regression and
not something to route around.** A package whose MANIFEST claims stage-level approval while five
requirements trace to nothing would be claiming an approval nobody gave — the same false success the
composed gate was built to surface.

⚠️ **It clears when stage 5 produces and approves the application components** — roadmap step 3a, after
step 2 answers `QST-0017…QST-0021`. Not before, and **not by re-attesting around it**. `docs/plan/`
therefore stays at snapshot `6c86330767dcbbfa`, describing the plan as it stood before this
decomposition, which is the honest thing for it to describe until the plan is finished again.
