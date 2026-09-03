# Stage 1 — Intake

> **Status: PM-CORRECTED.** Stage 1 is `decidedBy: User` (#34, `stages/01-intake.json`).
> This was reconstructed by the agent from the frozen source material — `Audio Transcription 1.md`,
> `Audio Transcription 2.md` and the consolidated vision doc — which are the PM's own words recorded
> before the current architecture settled. The material already contains candidate solutions—one
> transcript is explicitly labelled architecture refinement—so this stage extracts the problem and
> requested outcomes rather than pretending the source itself was solution-free.
>
> ⚠️ **Written under one deliberate constraint, which is what stage 1 is testing:** *the ask is written
> down without a solution attached.* Nothing below names a technology, an architecture, a document
> format, a pipeline shape, or an artifact type — not because those are unsettled, but because stage 1
> must be able to state the problem without them. Where a constraint really does come from the current
> environment it is recorded as a constraint, not as a design.

---

## The request, in the PM's terms

Build an AI-assisted project-planning capability that is **more structured, modular, context-aware and
deterministic** than the planning workflow currently in use at work.

> "The intended result is a planning environment in which implementation becomes increasingly
> deterministic because ambiguity and technical uncertainty are removed earlier in the lifecycle."

## Context — what is wrong with the current way of working

The existing environment is *functional but loose*: documents plus an AI agent, with no strongly defined
workflow connecting them. The user and the agent work out the process as they go. Four consequences were
called out directly:

1. **Session quality is inconsistent.** How good a planning session is depends on how the session
   happened to go.
2. **The agent cannot research.** It cannot check current vendor documentation, OS-specific procedures,
   package repositories, driver compatibility, version requirements or known issues, so on
   implementation-specific questions it reasons from what it already has. The PM's own description of
   this is *"educated guessing."*
3. **The agent cannot experiment.** With no sandbox or development environment, assumptions that could
   be tested are instead inferred.
4. **Because of 2 and 3, discovery moves to the wrong end of the process.** The runbook becomes the
   place where technical discovery happens — stated as *"the opposite of the intended workflow."*

The order the PM wants instead, quoted from the transcript:

```
Research → Experiment → Failure / Diagnosis → Correction → Validation
        → Documentation → Production Runbook → Execution
```

> "The runbook should represent the output of discovery, not the beginning of discovery."

## Objective

A planning process that progressively removes ambiguity and technical uncertainty **before**
implementation starts, so that by the time a runbook exists most discoverable uncertainty has already
been resolved. The target is **maximum practical determinism**, not a guarantee that production will be
perfectly predictable. The resulting handoff should be actionable without returning to the planner for
information the planning process should have supplied.

## Stakeholders

| Who | Interest |
|---|---|
| **The PM** (this repo's author) | Runs the planning process; is the person currently absorbing the cost of loose planning. The only confirmed user. |
| **Whoever implements the plan** | Receives the output and has to act on it. May be a person, an AI agent, or a mix — and the PM's material declines to assume which. |
| **The planning agent(s)** | Do the work inside the process rather than around it. |

⚠️ **Not a stakeholder yet, and worth saying so:** no second user, no team, no organisation. The source
material speculates about reusing knowledge across future projects; that is a later ambition, not a
present stakeholder.

## Constraints stated up front

- **Research capability is a prerequisite, not a feature.** Without it the planner guesses on exactly the
  questions that matter most.
- **Experimental validation is a prerequisite, not a feature.** Claims that can be tested should be
  tested before they become instructions.
- **Some claims cost money or need credentials to test.** The material raises cloud infrastructure
  directly, so validation cannot assume a free, local, consequence-free environment in every case.
- **The distinction between a guess, a documented claim, and a demonstrated one must survive to the
  end.** This is the PM's central complaint restated as a constraint: if the output cannot tell them
  apart, the problem is unsolved.

### Operating constraints added by the PM, 2026-09-02

Recorded here rather than only in `README.md`, because they are constraints on the ask and not
descriptions of the solution. They arrived with the agent-delivery work, which is the first part of
this project that runs somebody else's runtime against somebody else's paid service.

- **A first run assumes internet connectivity.** Cloning the tool, installing its locked
  dependencies, completing provider authentication and reaching a hosted model all need the network.
  No offline bootstrap, proxy configuration, private-registry support or custom-certificate handling
  is promised before 1.0.
- **Local inference engines are operated by the project manager, not by this system.** Where the
  configured model is served by llama.cpp, vLLM, Ollama, LM Studio or anything similar, its
  installation, model files, configuration, startup, health, hardware and shutdown belong to the
  project manager. This system may discover and validate the configuration; it does not provision or
  run the service.
- **Planning work may cost money.** The configured provider can bill for intake turns and for
  delegated specialist work. The project manager owns the account, the plan, the limits and the
  charges — and therefore any request that may be billed must be disclosed and authorised before it
  is sent, not merely reported afterwards.
- **The tool is not version-pinned for consumers yet.** Before 1.0 the documented clone follows the
  default branch, so a tool update may change behaviour under a project mid-cycle. This is
  deliberate until one complete project has been run end to end; a pinned release workflow follows.

⚠️ **The third of these is a constraint and not a preference, and it is the one that generalises.**
`REQ-0012` already required explicit authorisation before a *validation* spends money. Inference is
not validation, and the gap between those two words is how a planning turn could bill an account
nobody warned. The constraint is about the class of act — anything that spends the project manager's
money or uses their credentials — rather than about which subsystem performs it.

## Scope boundary — corrected by the PM

The frozen intake does **not** put all post-runbook activity out of scope. Its core vision explicitly
includes observing implementation results, retaining failures and lessons, and eventually reusing
organisational knowledge. A later priority list calls production execution, automatic monitoring and
cross-project reuse "subsequent", but that is sequencing rather than a clean product boundary.

The current project boundary was decided later as #24 and is confirmed here by the PM:

- **In:** planning, research, experimental validation, evidence, and production of the handoff/runbook.
- **Out:** executing the handoff, monitoring execution, ingesting production results, learning from
  production outcomes, and organisation-wide knowledge reuse.

This is a scope decision applied to the original request, not something the frozen intake said on its
own. Keeping the provenance explicit prevents a later product choice from masquerading as initial user
intent.

## Constraint removed by the PM's review

The first draft called "single operator, local development" an intake constraint. It is not present in
the frozen material; it came from the later local-first architecture. That architecture decision still
stands elsewhere, but it is not evidence about the solution-free ask and does not belong in this stage.

## Enough to determine which stages this project needs?

**Yes — confirmed by the PM after the corrections above.** The material describes work spanning intake,
decomposition, research, decision-capture, design, risk, acceptance, planning and handoff, plus a
validation activity that does not sit in any one of them. The current nine-stage set plus cross-cutting
validation covers the approved through-handoff scope without importing the deferred execution lifecycle.

---

## Open questions raised by this intake

| # | Question | Why it matters |
|---|---|---|
| 1 | Is the implementer a person, an agent, or both? | The source says do not assume. It changes what "usable output" means. |
| 2 | Is one operator a constraint or just today's implementation model? | The intake does not answer it; the later architecture chooses one local operator for v1. |
| 3 | What does "deterministic" mean concretely enough to test? | It is the objective, and as stated it is not yet falsifiable. |
| 4 | Which claims are worth the cost of real validation? | Not everything can or should be tested against real infrastructure. |

---

## Exit criteria — PM attestation required

`stages/01-intake.json` declares four, all `mechanised: false`. Each needs `satisfied`,
`not-satisfied`, or `n/a` **with a reason** (#93) — an evaluation, not an acknowledgement.

| Criterion | Agent's view, offered as input to the PM's judgement |
|---|---|
| `ask-without-solution` | **Satisfied after correction.** The local/single-operator back-projection was removed, and the later scope choice is labelled as a PM correction rather than attributed to the intake. |
| `objective-understood` | **Satisfied.** The objective is maximum practical determinism through earlier uncertainty reduction; open question 3 still owes measurable acceptance criteria later. |
| `constraints-recorded` | **Satisfied.** Research, experimental validation, governance, and preservation of claim strength are recorded; the unsupported local constraint was removed. |
| `stage-set-determinable` | **Satisfied.** The approved scope terminates at handoff and is covered by the nine stages plus cross-cutting validation. |
