# AI Project Planning and Validation Platform — Consolidated Vision and Planning Summary

**Date consolidated:** August 13, 2026  
**Source material:** Two voice transcripts, prior cleaned summaries, and subsequent architecture discussion  
**Project stage:** Early product definition / MVP architecture

---

## 1. Executive Summary

The project is evolving from a relatively simple AI-assisted project planning environment into a **stateful, evidence-driven engineering planning and validation platform**.

The core objective is to take a raw project idea and progressively transform it into a validated, executable plan. The system should reduce ambiguity through structured intake, targeted research, experimentation, technical validation, explicit decisions, and continuously updated documentation.

The central philosophy is:

> Planning should progressively convert uncertainty into evidence-backed decisions.

The system should not rely on a single long-running chat session or on an AI agent remembering everything implicitly through conversation context. Instead, it should maintain structured project state, durable artifacts, explicit decisions, evidence, and workflow state outside of any individual agent context window.

For the MVP, the current preferred architecture is a **multi-agent system** consisting of:

1. **Orchestrator Agent**
2. **Research Agent**
3. **Planning Agent**
4. **Validation Agent**
5. **Human Implementer** — initially the user
6. **Human Knowledge Curator** — initially the user

The user primarily interacts with the orchestrator. The orchestrator delegates bounded tasks to specialized agents, which each operate with scoped context, dedicated instructions, and explicit input/output contracts.

Longer term, the platform could add a dedicated reviewer/governor, implementation agent, knowledge curator, organization-wide knowledge repository, and richer sandbox orchestration.

---

# 2. Origin of the Project

The project emerged from frustration with an existing planning ecosystem used at work.

The current work environment includes planning documents and a coding agent, but the workflow is relatively loose. The user and the agent often have to determine the process as they go.

The current workflow lacks:

- a strongly defined planning pipeline;
- consistent project initialization;
- reliable context transfer between sessions;
- modular planning stages;
- automatic research;
- experimental validation;
- continuous evidence capture;
- automatic feedback from implementation into documentation;
- reusable knowledge across projects.

This makes planning quality too dependent on:

- how the first interaction is framed;
- what is already inside the context window;
- how much project history the agent happens to see;
- what assumptions the agent makes early;
- how the user structures prompts.

The desired system should reduce this variability by making the **planning framework itself part of the operating environment**.

---

# 3. Core Product Thesis

The product can be summarized as:

> A stateful AI project-planning and engineering-validation environment that converts an ambiguous project idea into a progressively validated, traceable, and executable plan while retaining the knowledge generated throughout the lifecycle.

A second formulation that emerged later is:

> Before asking a human or production agent to execute a plan, give the planning system the tools required to prove as much of that plan as reasonably possible.

The system is therefore not merely a documentation generator.

It is intended to combine:

- conversational discovery;
- structured project state;
- adaptive planning workflows;
- current research;
- sandboxed experimentation;
- technical validation;
- evidence-backed decision making;
- runbook generation;
- implementation feedback;
- reusable project knowledge.

---

# 4. Guiding Design Principles

Several design principles repeatedly surfaced.

## 4.1 Context should be engineered

The system should not depend on reconstructing project context from chat history on every session.

Agents should receive only the project state and artifacts required for their current task.

## 4.2 Agents are not the source of truth

A key architectural principle is:

> Agents may be stateless between tasks, while the project itself remains stateful.

The canonical project state should live outside the agents.

Agents read from and write to a durable project state layer.

## 4.3 Conversation is evidence, not state

Conversation history can inform decisions, but it should not be treated as the canonical representation of the project.

The system should distinguish among:

- raw conversation;
- extracted facts;
- assumptions;
- decisions;
- requirements;
- open questions;
- research findings;
- validated technical assertions;
- implementation evidence.

## 4.4 Questions should be adaptive

The system should not generate a large static questionnaire at the beginning of a project.

Instead, it should determine the next best question using what has already been learned.

## 4.5 Planning should reduce uncertainty

A planning phase is complete because a meaningful category of uncertainty has been reduced—not because a document has been filled out.

## 4.6 Evidence should support decisions

Research findings, test results, logs, and implementation output should be attached to decisions whenever practical.

## 4.7 Discovery and production should be separated

Discovery should happen in environments where failure is inexpensive.

Production should be executed from validated instructions.

## 4.8 Runbooks should be outputs of discovery

The runbook should not be where the project discovers that commands are wrong.

It should be the artifact produced after research and validation.

## 4.9 Failures are useful project knowledge

Technical failures, incorrect commands, missing prerequisites, and successful remediations should be retained.

## 4.10 The orchestrator should remain intentionally boring

The orchestrator should route, track, and coordinate work.

It should not become the domain expert or absorb the responsibilities of every sub-agent.

---

# 5. Desired User Experience

A new project could begin approximately as follows:

1. Create a project directory.
2. Optionally initialize Git.
3. Initialize or clone the planning environment.
4. Perform minimal configuration.
5. Launch the planning-aware agent environment.
6. Begin project intake.

If the project is empty, the system should recognize that it is a new project.

The first interaction could be as simple as:

> Describe what you want to build in as much detail as you currently can.

That description becomes the seed from which the rest of the project planning lifecycle is generated.

The system may infer or generate:

- a working project name;
- likely project type;
- required planning phases;
- an initial intake artifact;
- early assumptions;
- unresolved questions.

---

# 6. Conversational Intake Model

The intake system should avoid the common pattern of generating twenty questions at once.

That approach creates several problems:

- later questions may rely on assumptions invalidated by earlier answers;
- the user may have to repeat corrections;
- questions become stale as project state changes;
- multiple questions may unintentionally ask the same thing;
- cognitive load increases.

Instead, the intended intake loop is:

```text
Initial project description
        ↓
Agent interpretation
        ↓
Update structured project state
        ↓
Identify highest-value unknown
        ↓
Ask next question
        ↓
User response
        ↓
Update structured project state
        ↓
Repeat
```

A key example discussed involved file or directory structure.

If the agent proposes one directory layout and the user rejects it, later questions should operate against the replacement structure rather than repeatedly asking about the rejected version.

This implies a structured representation similar to:

```text
Original directory proposal:
Rejected

Replacement naming convention:
Accepted

Permission model:
Still unresolved
```

The system therefore needs more than conversation memory.

It needs explicit state.

---

# 7. The Agent as Planning Facilitator

The planning system should not merely interview the user.

It should actively help shape the project.

The agent should be able to:

- identify missing requirements;
- detect contradictions;
- surface assumptions;
- suggest industry practices;
- explain tradeoffs;
- translate informal ideas into precise technical requirements;
- identify decisions the user may not realize need to be made;
- help extract partially formed ideas;
- distinguish decisions from preferences;
- track unresolved questions.

The intention is closer to a strong technical facilitator or project architect than to a questionnaire.

---

# 8. Dynamic Project Pipeline

The same planning workflow should not necessarily apply to every project.

Instead, intake should help determine a project-specific planning pipeline.

Potential planning modules include:

- requirements;
- architecture;
- security;
- infrastructure;
- dependency analysis;
- API design;
- compatibility research;
- benchmarking;
- migration planning;
- deployment planning;
- validation planning;
- runbook creation.

This suggests the eventual need for some form of:

- project archetype;
- project classification;
- capability profile;
- risk profile;
- modular planning workflow.

The workflow should be dynamic while still being deterministic enough that similar projects receive similar treatment.

---

# 9. Multi-Agent Architecture

The later discussion clarified that the platform should likely use specialized agents rather than one large planning agent.

The current preferred MVP roles are described below.

---

## 9.1 Orchestrator Agent

### Purpose

The orchestrator is the primary interface between the user and the planning system.

The user should primarily communicate with the orchestrator.

### Responsibilities

- receive user input;
- determine current planning phase;
- maintain workflow state;
- create tasks for specialized agents;
- provide each sub-agent with scoped context;
- collect agent outputs;
- update task status;
- detect unmet dependencies;
- decide which agent should act next;
- request user decisions or reviews;
- enforce phase exit criteria;
- manage feedback loops between agents.

### Non-responsibilities

The orchestrator should not:

- perform deep research itself;
- become the primary technical architect;
- conduct sandbox experimentation;
- independently generate all project documentation;
- become the canonical knowledge store.

It is effectively the traffic controller.

---

## 9.2 Research Agent

### Purpose

Gather current external information required to answer unresolved project questions.

### Responsibilities

- perform internet research;
- prioritize authoritative sources;
- gather vendor documentation;
- compare alternatives;
- identify compatibility constraints;
- document assumptions;
- identify unresolved research questions;
- provide citations or source references;
- create research briefs.

### Important constraint

The research agent should produce **findings and hypotheses**, not automatically convert research into trusted production instructions.

Research evidence and experimentally validated evidence are not equivalent.

---

## 9.3 Validation Agent

### Purpose

Experimentally test technical assumptions in safe environments.

### Responsibilities

- provision or receive access to sandbox environments;
- execute proposed commands;
- observe output;
- capture logs;
- diagnose failures;
- iterate through remediation;
- compare observed results against expected results;
- record environment details;
- produce pass/fail conclusions;
- capture evidence artifacts;
- clean up temporary resources.

This agent is one of the most important differentiators of the system.

---

## 9.4 Planning Agent

### Purpose

Transform validated project information into coherent planning artifacts.

### Responsibilities

- synthesize requirements;
- maintain architecture documentation;
- update planning documents;
- translate validated technical conclusions into runbook steps;
- identify dependencies;
- maintain traceability between decisions and evidence;
- ensure downstream artifacts reflect upstream changes;
- produce implementation-ready artifacts.

The planning agent should preferentially generate implementation guidance from validated evidence rather than from unverified assumptions.

---

## 9.5 Human Implementer — MVP

For the initial version of the system, the user remains the production implementer.

This is intentional.

The user may:

- copy commands from the runbook;
- execute them on production systems;
- capture terminal output;
- feed execution evidence back into the platform.

This avoids prematurely introducing autonomous production access.

---

## 9.6 Human Knowledge Curator — MVP

The user also remains the knowledge curator during the MVP.

The system may capture lessons learned, but automatic promotion into a reusable organization-wide knowledge base is currently out of scope.

---

# 10. Potential Future Agent Roles

Several roles were discussed as future additions.

## Reviewer / Governor Agent

Potential responsibilities:

- challenge planning conclusions;
- check sufficiency of evidence;
- evaluate policy compliance;
- evaluate cost constraints;
- check sandbox fidelity;
- verify that phase exit criteria were actually satisfied;
- prevent weak evidence from being promoted.

A benefit of this role is avoiding the situation where the same agent both creates and approves its own work.

## Implementation Agent

A future implementation agent could execute approved runbooks.

Its role should intentionally be narrow.

It should:

- execute approved steps;
- avoid improvisation;
- record actual output;
- stop on unhandled deviations;
- escalate unexpected results.

The implementation agent should be boring by design.

## Knowledge Curator Agent

A future curator could:

- identify reusable patterns;
- retain environment-specific knowledge;
- separate one-off facts from generally reusable knowledge;
- attach provenance and confidence;
- update organizational standards.

---

# 11. Agent Context Model

The user proposed using a coding-agent harness such as Pi.

The preferred conceptual model is that each specialized agent has its own isolated context and instructions.

Each agent could have:

- a dedicated role definition;
- its own AGENTS.md or equivalent instruction file;
- a bounded context window;
- task-specific inputs;
- defined tools;
- explicit permissions;
- explicit output schema.

The orchestrator would provide only the context each role needs.

For example:

```text
Research Agent receives:
- target question
- relevant requirements
- environment constraints

Validation Agent receives:
- hypothesis
- candidate procedure
- required environment
- success criteria

Planning Agent receives:
- validated evidence
- decisions
- requirements
- artifact dependencies
```

Agents should not receive the entire project history by default.

This reduces context pollution and role leakage.

---

# 12. Agent Contracts

Each agent should have a concise operational contract.

At minimum, each contract should define:

- inputs;
- responsibilities;
- allowed tools;
- forbidden actions;
- output format;
- exit criteria;
- escalation conditions.

The quality of these contracts may matter more initially than the exact hosting implementation.

---

# 13. Research and Discovery

A major realization from the second transcript was that the current planning workflow cannot produce reliable technical instructions if the agent cannot access current documentation.

The current work agent lacks internet search, which causes it to infer implementation details from incomplete context.

This surfaced during work involving areas such as:

- RHEL 10;
- NVIDIA drivers;
- CUDA;
- Docker;
- GPU compatibility.

The agent could reason about system requirements but could not reliably confirm current vendor-supported installation procedures.

This led to the principle:

> Technical planning should use current authoritative research when implementation details may have changed.

---

# 14. Sandboxed Experimentation

Internet research alone is insufficient.

The agent also needs the ability to test whether a proposed procedure actually works.

The intended experimental loop is:

```text
Question
   ↓
Research authoritative sources
   ↓
Generate hypothesis
   ↓
Provision representative environment
   ↓
Test
   ↓
Observe
   ↓
Fail if necessary
   ↓
Diagnose
   ↓
Modify
   ↓
Retest
   ↓
Capture evidence
```

Failure is expected during this phase.

The point is to move failures earlier, into disposable environments.

---

# 15. Sandbox Options

Possible sandbox types include:

- local Docker containers;
- local virtual machines;
- cloud VMs;
- GPU-enabled cloud instances;
- Kubernetes environments;
- isolated development servers;
- Terraform-provisioned infrastructure.

The broader architecture should not hard-code sandboxing to one particular infrastructure provider.

Instead, sandbox execution should eventually become a generalized capability.

---

# 16. Environment Fidelity

The test environment should match the production environment as closely as practical for the variables that materially affect behavior.

Relevant variables may include:

- operating system;
- OS version;
- CPU architecture;
- GPU vendor and family;
- kernel;
- driver version;
- package manager;
- CUDA version;
- Docker version;
- network constraints;
- security controls.

Perfect one-to-one fidelity may not always be required.

However, the system should represent how closely the validation environment matches the target.

This leads to the concept of **validation confidence based on environment similarity**.

---

# 17. Example: GPU Driver Validation

A concrete example discussed was validating NVIDIA and CUDA installation on RHEL 10.

A possible future workflow would be:

```text
Research Agent
    ↓
Determine supported installation paths
    ↓
Validation Agent
    ↓
Provision temporary RHEL 10 + NVIDIA GPU environment
    ↓
Install drivers and CUDA
    ↓
Capture failures and remediations
    ↓
Confirm final working procedure
    ↓
Planning Agent
    ↓
Generate validated runbook
```

For personal use, one possible implementation would be temporary AWS infrastructure created through Terraform.

The user specifically envisioned the possibility of using a GPU-enabled EC2 instance, potentially with hardware such as a Tesla V100 or similar representative NVIDIA GPU.

The exact cloud platform is not a core requirement.

The real requirement is the ability to provision disposable, representative infrastructure.

---

# 18. Sandbox Governance

Sandbox autonomy introduces new risks.

The system should eventually support explicit policies covering:

- allowed cloud providers;
- allowed accounts;
- approved regions;
- instance families;
- maximum instance count;
- maximum runtime;
- cost ceilings;
- network access;
- production network isolation;
- credential scope;
- automatic teardown;
- resource tagging;
- audit logs.

This is necessary because an agent repeatedly creating GPU resources can become expensive or unsafe.

---

# 19. Evidence Model

A critical architectural distinction is:

```text
Research finding
≠
Experimentally validated finding
≠
Production validated finding
```

The system should explicitly preserve these distinctions.

A possible confidence ladder is:

```text
Unverified
Source-supported
Experimentally validated
Environment-matched validation
Production validated
```

This may ultimately become one of the most important parts of the platform.

---

# 20. Technical Assertions

Technical knowledge could eventually be modeled as structured assertions.

For example:

```yaml
assertion: "NVIDIA driver installation method"
status: experimentally_validated

source_support:
  - vendor_documentation

validation:
  operating_system: RHEL 10
  gpu_family: NVIDIA
  environment_match: partial
  result: success

production_validation:
  status: pending
```

The planning agent could then preferentially build runbooks from assertions meeting a required confidence threshold.

---

# 21. Evidence Store

The project should maintain an evidence layer that can hold or reference:

- source material;
- web research;
- terminal output;
- command history;
- configuration files;
- screenshots;
- logs;
- test results;
- environment metadata;
- benchmark results;
- remediation attempts;
- final successful outcomes.

Evidence should be attachable to:

- requirements;
- decisions;
- technical assertions;
- runbook steps;
- implementation results.

---

# 22. Decision Register

A lightweight but formal decision register should be part of the lifecycle.

A decision entry should include:

- decision;
- alternatives considered;
- rationale;
- relevant evidence;
- assumptions;
- date;
- status;
- downstream dependencies.

This helps prevent the main planning document from becoming a large unstructured collection of everything that was discussed.

It also preserves why a choice was made.

---

# 23. Distinguishing Information Types

The system should explicitly distinguish among:

- facts;
- assumptions;
- decisions;
- constraints;
- risks;
- open questions;
- hypotheses;
- validated findings.

These should not be blended together.

For example:

```text
Fact:
Production environment uses RHEL 10.

Assumption:
The selected NVIDIA package is compatible with the production GPU.

Question:
Which driver branch is officially supported?

Research finding:
Vendor documentation recommends branch X.

Validation:
Branch X installed successfully in representative sandbox.

Decision:
Use branch X in the production runbook.
```

This structure makes reasoning and traceability much clearer.

---

# 24. Question Backlog

Unknowns should be explicitly tracked rather than treated as planning failures.

The project should maintain a backlog of unresolved questions.

Questions can be:

- assigned to research;
- assigned to validation;
- escalated to the user;
- deferred;
- marked as blocked;
- closed with evidence.

This gives the orchestrator a structured way to decide what should happen next.

---

# 25. Phase Exit Criteria

One of the most important recommendations from the architecture discussion was to avoid subjective definitions of completion.

Research should not be complete because it "feels done."

A planning phase should have explicit exit criteria.

Examples:

## Intake exit criteria

- project objective understood;
- major constraints recorded;
- critical stakeholders or environments identified;
- enough information exists to determine the next planning modules.

## Research exit criteria

- required questions answered;
- authoritative sources collected;
- contradictory findings resolved or surfaced;
- remaining unknowns explicitly recorded.

## Validation exit criteria

- target assertions tested;
- observed output captured;
- known failures documented;
- required confidence threshold reached.

## Runbook exit criteria

- required steps based on validated evidence;
- expected output documented;
- dependencies and ordering explicit;
- unresolved critical questions absent.

The orchestrator can then ask a simple question:

> Is this phase complete according to its contract?

---

# 26. Documentation Lifecycle

The intake artifact should be the initial structured representation of the project, but it should not become permanently frozen.

As the project progresses:

- research may challenge requirements;
- validation may invalidate assumptions;
- architecture may introduce new constraints;
- implementation may reveal environment-specific differences.

The system therefore needs dependency-aware documentation.

For example:

```text
Requirement changes
        ↓
Architecture potentially affected
        ↓
Validation evidence potentially stale
        ↓
Runbook potentially invalid
```

The system should know which artifacts require reevaluation when upstream decisions change.

---

# 27. Raw Conversation Logging

Meaningful user-agent interactions should be retained for traceability.

However, storing conversation is not enough.

The system should ideally maintain separate layers:

```text
Raw Interaction History
        ↓
Extracted Facts / Questions
        ↓
Decisions / Requirements
        ↓
Current Project State
        ↓
Generated Artifacts
        ↓
Evidence
```

Raw conversation is useful for audit and reconstruction.

Structured state is what agents should rely on operationally.

---

# 28. Runbook Philosophy

The runbook should be the result of completed planning and validation.

The intended lifecycle is:

```text
Research
   ↓
Prototype
   ↓
Test
   ↓
Failure
   ↓
Remediation
   ↓
Validation
   ↓
Documentation
   ↓
Runbook
```

The runbook should contain:

- ordered commands;
- prerequisites;
- environment requirements;
- expected output;
- validation criteria;
- known exceptions;
- remediation guidance where appropriate;
- evidence references.

The goal is maximum practical determinism.

The system should avoid claiming that production can ever be absolutely guaranteed.

---

# 29. Human-in-the-Loop Production Execution

For production environments, the user may intentionally remain the execution boundary.

Reasons include:

- security;
- policy;
- compliance;
- lack of permission to give an agent direct access;
- personal preference;
- desire for human control.

The desired workflow is:

```text
Runbook step
    ↓
User copies command
    ↓
User executes on production
    ↓
User captures output
    ↓
Output added to platform
    ↓
Agent validates result
    ↓
Pass / Fail
```

This gives the system production evidence without requiring production credentials.

---

# 30. Automatic Runbook Monitoring

A major workflow frustration is the need to copy the same terminal output into both project documentation and the agent conversation.

The desired future model is event-driven.

When a user updates a runbook step with execution output:

```text
User updates step
      ↓
Platform emits event
      ↓
Agent receives:
- command
- output
- expected result
- project context
      ↓
Agent validates
      ↓
Step state updates automatically
```

Possible mechanisms include:

- webhooks;
- change events;
- background jobs;
- message queues;
- workflow triggers.

The exact mechanism is an implementation detail.

---

# 31. Runbook Step States

Possible execution states include:

```text
Pending
Running
Passed
Failed
Remediated
Skipped
Blocked
```

A successful step could show:

```text
Install NVIDIA Drivers
✓ Validated
```

A failed step should capture:

```text
Expected result
Observed result
Likely cause
Recommended remediation
```

The remediation itself should then generate new evidence.

---

# 32. Failure and Remediation Logging

When a technical step fails, the system should record:

- command;
- environment;
- expected output;
- observed output;
- error;
- diagnosis;
- remediation;
- remediation command;
- remediation output;
- final result.

This creates a reusable history of how the system reached the final procedure.

---

# 33. Lessons Learned

Lessons learned should emerge continuously, not only at the end of a project.

Examples include:

- undocumented prerequisites;
- unsupported package paths;
- misleading documentation;
- environment-specific differences;
- ordering constraints;
- configuration edge cases;
- replacement commands;
- improved wording.

For the MVP, these lessons can remain project-local and be reviewed manually by the user.

---

# 34. Organizational Knowledge — Future Scope

A longer-term concept is an organization-wide shared knowledge repository.

Multiple project planners could reuse validated organizational knowledge.

Example:

```text
Organization
│
├── Project A
├── Project B
├── Project C
│
└── Shared Knowledge Repository
```

The repository could contain:

- validated installation patterns;
- environment-specific fixes;
- known hardware behavior;
- standard infrastructure patterns;
- approved architectures;
- troubleshooting knowledge;
- repeated implementation lessons.

This should not be built too early.

---

# 35. Knowledge Promotion Problem

A critical challenge with organizational learning is that not every observation should become generalized knowledge.

The system must distinguish:

```text
Project-specific fact
Reusable pattern
Validated organizational standard
```

Future knowledge entries may need:

- provenance;
- confidence;
- applicability constraints;
- environment fingerprint;
- validation status;
- source project;
- versioning.

Without these controls, a shared knowledge base could spread incorrect assumptions.

---

# 36. MVP Scope

The current conversation converged on a deliberately narrower MVP.

## Include

### Orchestrator

Primary user interface and workflow manager.

### Research Agent

Current external research and cited findings.

### Planning Agent

Structured planning artifacts and runbook generation.

### Validation Agent

Sandbox experimentation and evidence capture.

### User as Implementer

The user executes production steps manually.

### User as Knowledge Curator

The user decides which lessons are reusable.

---

# 37. Explicitly Deferred Capabilities

The following are valuable, but not necessary for the initial MVP:

- autonomous production implementation agent;
- autonomous organizational knowledge curator;
- organization-wide knowledge repository;
- sophisticated governance agent;
- large-scale cross-project learning;
- fully automated production feedback loops;
- advanced environment-fidelity scoring;
- unrestricted cloud autonomy;
- complex enterprise multi-project collaboration.

These should remain visible on the roadmap without contaminating the first implementation.

---

# 38. Recommended MVP Workflow

A practical first version could operate as follows.

## Stage 1 — Intake

The user communicates only with the orchestrator.

The orchestrator gathers the raw project description and routes clarification tasks.

Outputs:

- project summary;
- requirements;
- constraints;
- assumptions;
- question backlog.

## Stage 2 — Planning Breakdown

The orchestrator determines what planning work is required.

Outputs:

- planning phases;
- tasks;
- owners;
- dependencies.

## Stage 3 — Research

Research tasks are delegated to the research agent.

Outputs:

- research briefs;
- source-backed findings;
- unresolved questions;
- hypotheses requiring validation.

## Stage 4 — Validation

Technical hypotheses are delegated to the validation agent.

Outputs:

- environment description;
- command history;
- logs;
- failures;
- remediations;
- validated assertions;
- confidence level.

## Stage 5 — Planning Synthesis

The planning agent incorporates validated findings.

Outputs may include:

- architecture;
- implementation design;
- dependencies;
- runbook;
- expected results;
- evidence links.

## Stage 6 — Human Review

The orchestrator presents material changes and unresolved decisions to the user.

The user approves, rejects, or modifies.

## Stage 7 — Implementation

The user executes the runbook.

Observed output is recorded.

## Stage 8 — Feedback

Failures and successes update project state.

The planning agent updates documentation when necessary.

## Stage 9 — Closeout

The project captures:

- final state;
- implementation evidence;
- deviations;
- lessons learned;
- unresolved follow-up items.

---

# 39. Event-Driven Workflow Model

The project should ultimately operate more like a workflow engine than a single chat thread.

Example events:

```text
Project initialized
Research requested
Research completed
Validation requested
Validation passed
Validation failed
Decision required
Decision approved
Artifact updated
Runbook ready
Implementation evidence submitted
Execution passed
Execution failed
```

The orchestrator reacts to these events and determines the next task.

This reduces hidden logic inside conversations.

---

# 40. Suggested Canonical State Domains

The system will likely need durable state for at least the following domains:

## Project

- name;
- description;
- stage;
- type;
- status.

## Requirements

- functional;
- non-functional;
- environmental;
- security;
- operational.

## Questions

- question;
- owner;
- status;
- priority;
- resolution.

## Decisions

- choice;
- alternatives;
- rationale;
- evidence;
- status.

## Assertions

- technical claim;
- confidence;
- evidence;
- environment.

## Tasks

- assigned agent;
- input;
- expected output;
- state;
- dependencies.

## Evidence

- sources;
- logs;
- commands;
- artifacts;
- results.

## Artifacts

- intake;
- architecture;
- research reports;
- decision records;
- runbooks;
- lessons learned.

---

# 41. Canonical Source of Truth — Unresolved

One major architecture decision remains unresolved:

> What is the canonical project state representation?

Possible approaches include:

- Markdown;
- YAML;
- JSON;
- relational database;
- document database;
- event-sourced model;
- hybrid architecture.

A likely direction is that Markdown remains the human-readable artifact layer while structured machine state is stored separately.

Using Markdown itself as the authoritative database may become brittle once agents must reliably update dependencies, state, evidence links, and task status.

---

# 42. Documentation vs Machine State

A strong separation may be:

```text
Machine State
- authoritative
- structured
- queryable
- deterministic

Human Documentation
- readable
- reviewable
- generated or synchronized from state
```

This would allow the platform to maintain consistent agent behavior without sacrificing human-friendly documents.

---

# 43. Current Workaround for Limited Work Environment

The current work environment does not provide the desired research and sandbox capabilities.

A short-term workaround discussed is:

1. Use an internet-capable external agent such as Codex to research a technical question.
2. Generate a structured report.
3. Transfer that report into the work planning environment.
4. Point the existing agent at the report.
5. Update project documentation.
6. Manually test the resulting procedure.

This creates a bridge until the broader system exists.

---

# 44. Cross-Boundary Research Packages

The workaround suggests a useful future artifact type: a portable research package.

A research package could include:

- research question;
- sources;
- conclusions;
- assumptions;
- environment;
- tested commands;
- validation results;
- applicability constraints;
- confidence level.

This would be especially useful when research must occur outside a restricted work environment.

---

# 45. Key Risks

Several risks have been identified.

## Context-window overuse

Persistent project understanding should not be solved by continuously stuffing more information into agent context.

## Documentation-as-database

Human-readable Markdown alone may be too fragile as canonical state.

## Agent role leakage

Without strict contracts, specialized agents may start doing one another's jobs.

## Orchestrator bloat

The orchestrator could gradually become a monolithic super-agent.

## False determinism

Sandbox success should not be represented as a production guarantee.

## Environment mismatch

Tests may pass in a sandbox while production differs materially.

## Knowledge contamination

Incorrect project-specific conclusions could become generalized organizational knowledge.

## Cost runaway

Agent-controlled cloud resources, particularly GPU instances, can create significant cost.

## Resource leakage

Temporary infrastructure may remain running.

## Credential exposure

Agents require narrowly scoped permissions.

## Recursive automation

Artifact updates and triggers could accidentally create event loops.

## Documentation churn

Automatically updating every downstream artifact after every state change could produce excessive noise.

---

# 46. Critical Framing Challenge

An important shift in framing is that the product should not be optimized around producing a "final planning document."

A single planning document may still be a useful output, but it is not the true system.

The real product is a structured planning state plus a collection of linked artifacts and evidence.

The final planning document should be viewed as a human-readable projection of that state.

This matters because a single document cannot reliably represent:

- workflow status;
- changing assumptions;
- evidence confidence;
- task ownership;
- execution state;
- artifact dependencies;
- validation history.

---

# 47. Thin Vertical Slice Recommendation

The most practical way to validate the architecture is to implement one narrow technical problem end-to-end.

The NVIDIA / CUDA installation scenario is a useful example.

A thin slice could include:

1. User gives orchestrator the target environment.
2. Orchestrator creates a research task.
3. Research agent finds current authoritative guidance.
4. Orchestrator creates a validation task.
5. Validation agent tests the recommended approach.
6. Validation evidence is stored.
7. Planning agent creates a runbook.
8. User reviews it.
9. User manually runs it against the target.
10. Output is recorded.
11. Final result becomes a project lesson.

This would exercise most of the core architecture without requiring the entire product to exist.

---

# 48. Most Important MVP Design Decisions

Before implementation, the highest-value architectural decisions appear to be:

1. **Canonical project state model**
2. **Agent task and contract format**
3. **Orchestrator routing model**
4. **Artifact structure**
5. **Evidence model**
6. **Decision register format**
7. **Question backlog model**
8. **Phase exit criteria**
9. **Sandbox interface**
10. **Agent permission model**

These decisions will shape nearly everything else.

---

# 49. Suggested Initial Repository Structure

A conceptual repository could eventually look something like:

```text
project/
├── project.yaml
├── state/
│   ├── requirements.yaml
│   ├── questions.yaml
│   ├── decisions.yaml
│   ├── assertions.yaml
│   └── tasks.yaml
│
├── agents/
│   ├── orchestrator/
│   │   └── AGENTS.md
│   ├── research/
│   │   └── AGENTS.md
│   ├── planning/
│   │   └── AGENTS.md
│   └── validation/
│       └── AGENTS.md
│
├── artifacts/
│   ├── intake.md
│   ├── architecture.md
│   ├── research/
│   ├── decisions/
│   ├── validation/
│   └── runbooks/
│
├── evidence/
│   ├── sources/
│   ├── logs/
│   ├── command-output/
│   └── tests/
│
└── workflows/
    └── project-lifecycle.yaml
```

This is only a conceptual structure, not a final design.

---

# 50. Example End-to-End Lifecycle

The current vision can be summarized as:

```text
Raw idea
   ↓
Orchestrator
   ↓
Conversational intake
   ↓
Structured project state
   ↓
Question backlog
   ↓
Research tasks
   ↓
Source-backed findings
   ↓
Validation tasks
   ↓
Sandbox experimentation
   ↓
Evidence-backed assertions
   ↓
Decisions
   ↓
Planning synthesis
   ↓
Validated runbook
   ↓
Human implementation
   ↓
Execution evidence
   ↓
Corrections / lessons learned
   ↓
Updated project state
```

The future version could extend this into organizational learning.

---

# 51. Current Architectural Direction

The strongest architectural direction from the combined discussion is:

> The platform should be a stateful orchestrated system composed of relatively stateless specialist agents operating against a canonical project state and evidence layer.

The orchestrator should manage:

- task routing;
- phase transitions;
- dependencies;
- user interaction.

Specialist agents should perform bounded work.

Artifacts should be durable.

Evidence should be explicit.

The user should remain an intentional approval and production-execution boundary for the MVP.

---

# 52. Recommended Near-Term Focus

The immediate focus should remain narrow.

The next implementation effort should likely prove these five capabilities:

1. **One user-facing orchestrator**
2. **One research sub-agent**
3. **One validation sub-agent**
4. **One planning sub-agent**
5. **A shared structured state/evidence store**

Everything else can be layered on after this loop proves itself.

The most important thing to avoid is building the organization-wide knowledge ecosystem or autonomous implementation machinery before the core planning loop has demonstrated that it can reliably move:

```text
Question → Research → Validation → Decision → Plan
```

That loop is the foundation of the product.

---

# 53. Final Product Definition

At its current stage, the project can be described as:

> An AI-assisted project planning and engineering validation system where a user works through a single orchestrator that delegates research, validation, and planning tasks to specialized agents. The system maintains structured project state, explicit decisions, open questions, and evidence outside of agent context windows. Technical assumptions are researched and, when practical, experimentally validated in disposable environments before being promoted into implementation runbooks. The user remains the production implementer and knowledge curator in the MVP, while more autonomous execution and cross-project learning are deferred to later phases.

The system's core promise is not merely better documentation.

It is **better confidence in the plan before implementation begins**.
