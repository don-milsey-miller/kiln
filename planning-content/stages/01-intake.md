# Stage 1 — Intake

> **Status: DRAFT, awaiting PM correction.** Stage 1 is `decidedBy: User` (#34, `stages/01-intake.json`).
> This was reconstructed by the agent from the frozen source material — `Audio Transcription 1.md`,
> `Audio Transcription 2.md` and the consolidated vision doc — which are the PM's own words recorded
> **before any solution existed**. That is the most faithful source available, and it is still a
> reconstruction. Correct it; do not ratify it.
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

A planning process that removes ambiguity and technical uncertainty **before** implementation starts, so
that what is handed to whoever implements it can be acted on without returning to the planner to resolve
missing information.

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
- **Single operator, local development.** One person, on one machine, working locally.

## What is explicitly out of scope

- Executing the plan.
- Monitoring or supervising execution.
- Learning from production outcomes.
- Any organisation-wide knowledge system.

⚠️ These are recorded here as **stated scope**, not derived from the architecture. The source material
raises all four as future ambitions and none as present work.

## Enough to determine which stages this project needs?

**Yes — and that is a claim for the PM to confirm, not the agent.** The material describes work spanning
intake, decomposition, research, decision-capture, design, risk, acceptance, planning and handoff, plus a
validation activity that does not sit in any one of them. Whether that means nine stages, or a different
set, is a stage-1 exit decision.

---

## Open questions raised by this intake

| # | Question | Why it matters |
|---|---|---|
| 1 | Is the implementer a person, an agent, or both? | The source says do not assume. It changes what "usable output" means. |
| 2 | Is one operator a constraint or just today's situation? | Determines whether concurrent use is in scope at all. |
| 3 | What does "deterministic" mean concretely enough to test? | It is the objective, and as stated it is not yet falsifiable. |
| 4 | Which claims are worth the cost of real validation? | Not everything can or should be tested against real infrastructure. |

---

## Exit criteria — PM attestation required

`stages/01-intake.json` declares four, all `mechanised: false`. Each needs `satisfied`,
`not-satisfied`, or `n/a` **with a reason** (#93) — an evaluation, not an acknowledgement.

| Criterion | Agent's view, offered as input to the PM's judgement |
|---|---|
| `ask-without-solution` | Believed satisfied — no technology, format or architecture appears above. Worth checking adversarially, since the agent writing it knows the solution. |
| `objective-understood` | Believed satisfied, with the caveat that "deterministic" is open question 3. |
| `constraints-recorded` | Believed satisfied. |
| `stage-set-determinable` | **PM's call.** The agent should not decide the pipeline shape. |
