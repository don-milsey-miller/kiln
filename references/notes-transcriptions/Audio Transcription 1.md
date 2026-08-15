Project Planning Capability — Validation, Sandboxing, and Research Notes

Source: Voice transcript  
Date: August 13, 2026  
Stage: Early concept / architecture refinement

1. Main Insight From This Iteration

The current planning workflow is exposing an important architectural weakness:

A planning agent cannot reliably produce implementation-grade instructions if it cannot research the current environment or experimentally validate its assumptions.

The present system can reason from requirements and existing documentation, but it lacks two critical capabilities:

1. Internet research
2. Direct access to a sandbox or development environment

Without those capabilities, the agent is forced to infer implementation details that should instead be verified.

The result is predictable: the runbook becomes the place where technical discovery happens.

That is the opposite of the intended workflow.

The desired model is:

Research

    ↓

Experiment

    ↓

Failure / Diagnosis

    ↓

Correction

    ↓

Validation

    ↓

Documentation

    ↓

Production Runbook

    ↓

Execution

The runbook should represent the output of discovery, not the beginning of discovery.

  

2. Problems Observed in the Current System

Three closely related deficiencies are becoming apparent.

2.1 No Internet Research

The coding agent currently does not have Internet search capabilities.

As a result, it cannot independently verify:

- current vendor documentation;
- operating-system-specific installation procedures;
- package repositories;
- driver compatibility;
- version requirements;
- known issues;
- changed installation procedures;
- current best practices.

Instead, the agent reasons primarily from the information already available to it.

For implementation-specific questions, this often becomes educated guessing.

That is not sufficient for generating reliable production instructions.

Example

A current problem involves determining the correct installation procedure for NVIDIA and CUDA components on RHEL 10.

This is precisely the type of problem where the agent should be able to consult authoritative and current sources before recommending commands.

  

3. No Experimental Environment

The second major limitation is that the agent cannot independently execute its recommendations against a representative system.

This prevents it from testing questions such as:

- Does this package exist?
- Does this repository work?
- Does this command succeed?
- Is this driver compatible?
- Does this service start?
- Does this configuration survive reboot?
- Does Docker behave as expected?
- Does the expected output actually occur?

The agent therefore generates instructions without proving that they work.

This creates a gap between:

"The agent believes this should work"

and:

"The system has demonstrated that this works"

The planning ecosystem should aim for the second condition whenever practical.

  

4. Excessive Manual Copy/Paste

A downstream symptom of these limitations is the amount of manual work currently required.

The present workflow often looks like:

Agent recommends command

        ↓

User copies command

        ↓

User runs command

        ↓

User copies output

        ↓

User pastes output into project documentation

        ↓

User copies/pastes again into agent conversation

        ↓

Agent interprets result

        ↓

Documentation gets updated

The same information is effectively being entered twice.

This is workable for experimentation, but it is inefficient and creates unnecessary cognitive and operational overhead.

The long-term system should eliminate this duplication.

  

5. Planning Needs an Experimental Loop

The broader realization is that infrastructure planning is itself an experimental process.

When building an unfamiliar system manually, the natural workflow is:

Attempt implementation

        ↓

Fail

        ↓

Investigate

        ↓

Modify approach

        ↓

Try again

        ↓

Progress further

        ↓

Repeat

Each attempt produces useful information.

A planning agent should be able to perform the same iterative process.

Failure should therefore be treated as part of research rather than as evidence that planning has failed.

The objective is to move those failures earlier in the lifecycle.

  

6. Proposed Development / Validation Range

The planning ecosystem should include a temporary development environment where the agent is explicitly allowed to experiment.

This could take several forms:

- disposable virtual machines;
- cloud instances;
- Docker containers;
- Kubernetes environments;
- local VMs;
- isolated development servers;
- temporary cloud infrastructure.

The agent should be able to:

1. Provision an appropriate environment.
2. Execute proposed implementation steps.
3. Observe results.
4. Diagnose failures.
5. Research failures when necessary.
6. Modify the implementation.
7. Retry.
8. Record successful procedures.
9. Tear down resources when finished.

Conceptually:

Planning Agent

      │

      ▼

Sandbox Controller

      │

      ├── Provision

      ├── Execute

      ├── Observe

      ├── Reset

      └── Destroy

      │

      ▼

Disposable Test Environment

  

7. Environment Fidelity

The validation environment does not always need to perfectly replicate production.

Instead, it should reproduce the variables that materially affect the implementation.

For example:

Target Environment

- RHEL 10

- NVIDIA GPU

- Docker

- CUDA

A useful test environment should attempt to match:

- operating system;
- operating system version;
- architecture;
- hardware class;
- GPU vendor;
- relevant software versions;
- package-management behavior;
- important security constraints.

The closer the environment can reasonably get to production, the stronger the resulting validation.

However, perfect fidelity should not become an unnecessary blocker.

The system needs a concept of validation confidence based on environment similarity.

  

8. Cloud-Based Experimental Infrastructure

For personal projects, cloud infrastructure could provide the experimental range.

One possible workflow is to expose controlled infrastructure resources to the agent through infrastructure-as-code tooling.

For example:

Agent

   ↓

Terraform

   ↓

AWS

   ↓

Temporary EC2 Instance

   ↓

Experiment / Validate

   ↓

Capture Results

   ↓

Destroy Instance

An example workload might require:

- RHEL 10;
- an NVIDIA-compatible GPU;
- sufficient compute and storage;
- temporary network access.

The agent could provision the closest available equivalent, perform the required experiments, capture findings, and tear the environment down afterward.

The important capability is not AWS specifically.

The capability is agent-controlled disposable infrastructure.

  

9. Resource Governance

Giving an agent infrastructure access introduces a significant requirement that was only implicit in the original concept:

Sandbox autonomy must have explicit boundaries.

The agent should not simply receive unrestricted cloud access.

The system likely needs policy constraints such as:

- approved regions;
- approved instance families;
- maximum runtime;
- maximum cost;
- maximum number of resources;
- approved network exposure;
- approved operating systems;
- automatic teardown;
- credential scoping;
- infrastructure tagging;
- audit logging.

For example:

Sandbox Policy

  

Provider: AWS

Region: us-east-1

Allowed instance types:

- g4dn.xlarge

- g5.xlarge

  

Maximum instances: 1

Maximum lifetime: 4 hours

Auto-destroy: Required

Internet access: Allowed

Production network access: Denied

Without this layer, experimental autonomy could become unnecessarily expensive or unsafe.

  

10. Research + Execution Should Be Combined

Internet research alone is not sufficient.

Execution alone is also not sufficient.

The two capabilities reinforce one another.

The ideal workflow is:

Question

   ↓

Search authoritative sources

   ↓

Develop hypothesis

   ↓

Test hypothesis

   ↓

Observe result

   ↓

Search failure if necessary

   ↓

Revise

   ↓

Retest

   ↓

Record validated result

This is closer to how a capable engineer actually solves unfamiliar technical problems.

The planning ecosystem should support that entire loop.

  

11. Research and Discovery Should Produce Evidence

The research/discovery phase should not simply output prose.

It should produce evidence that later planning stages can consume.

Potential evidence types include:

- source references;
- documentation links;
- tested commands;
- environment details;
- package versions;
- terminal output;
- configuration files;
- benchmark results;
- screenshots;
- logs;
- known failures;
- successful remediations.

The planning system should be able to associate these with specific decisions.

For example:

Decision:

Use installation method B.

  

Evidence:

- Vendor documentation recommends B.

- Method A failed on RHEL 10.

- Method B succeeded in test environment.

- GPU detected after reboot.

- CUDA validation test passed.

This creates a substantially stronger planning artifact than simply recording:

Install using method B.

  

12. Runbook Philosophy

The transcript reinforces a central principle of the system:

The runbook should be executable evidence of completed planning.

By the time the runbook is produced:

- commands should already have been tested where practical;
- dependencies should be identified;
- ordering should be validated;
- expected outputs should be known;
- known failures should be documented;
- remediation should already exist for foreseeable problems.

The runbook should therefore function more like a validation checklist than an experimental notebook.

  

13. Desired Production Workflow

The ideal implementation workflow becomes:

Validated Runbook

       ↓

Step 1

       ↓

Execute Command

       ↓

Compare Actual vs Expected

       ↓

Pass

       ↓

Step 2

       ↓

Execute Command

       ↓

Compare Actual vs Expected

       ↓

Pass

       ↓

...

       ↓

System Built to Specification

If an unexpected failure occurs, that failure becomes new evidence and feeds back into the planning system.

But unexpected failures should be exceptions rather than the normal development process.

  

14. Two Execution Models

The architecture should support two distinct modes.

Mode A — Agent-Executed Validation

Used for:

- development;
- testing;
- sandboxes;
- disposable environments;
- research environments.

The agent can directly execute commands.

Agent → Environment

Mode B — Human-Executed Production

Used when:

- production credentials cannot be delegated;
- security policies prohibit agent access;
- manual validation is desired;
- regulated systems require human operation.

Agent → Runbook → Human → Production

                          ↓

                     Execution Evidence

                          ↓

                        Agent

The planning system should be designed so that both workflows use the same underlying runbook and validation model.

  

15. Current Workaround

For the immediate project, rebuilding the architecture is not practical.

The short-term workaround is to introduce an external research capability.

For example:

1. Use an Internet-enabled research agent to investigate the NVIDIA/CUDA installation process.
2. Produce a detailed technical report.
3. Provide that report to the existing planning agent.
4. Update the existing project documentation.
5. Manually test the resulting procedure.
6. Feed results back into the planning agent.

Conceptually:

Internet-Enabled Research Agent

          ↓

Technical Report

          ↓

Existing Planning Agent

          ↓

Updated Documentation

          ↓

Manual Validation

This is inefficient compared with the desired architecture, but it provides a workable bridge.

  

16. Cross-Boundary Knowledge Transfer

This workaround also suggests another useful capability.

In environments where one agent cannot access external resources, research could be conducted elsewhere and imported as a formal evidence package.

For example:

Personal Research Environment

          ↓

Research Package

          ↓

Controlled Transfer

          ↓

Work Planning Environment

The transfer artifact could include:

- conclusions;
- tested procedures;
- sources;
- assumptions;
- applicability constraints;
- environment details;
- validation results.

This would be safer and more structured than manually copying arbitrary conversation history between environments.

  

17. Lessons-Learned Accumulation

The agent should retain successful and unsuccessful implementation attempts.

Over time, this creates reusable knowledge such as:

RHEL 10

+ NVIDIA Hardware Family X

+ CUDA Version Y

  

Known working procedure:

1. ...

2. ...

3. ...

  

Known failure:

Package Z unavailable using repository A.

  

Resolution:

Enable repository B before installation.

Future projects should then begin with previously validated knowledge instead of restarting from first principles.

  

18. Knowledge Should Reduce Future Research

The longer-term value proposition is not merely storing documentation.

It is reducing the amount of experimentation required for subsequent projects.

The maturity curve could look like:

Project 1

High research

High experimentation

High failure rate

        ↓

Knowledge captured

        ↓

Project 2

Less research

Less experimentation

        ↓

Knowledge captured

        ↓

Project N

Known patterns applied automatically

Validation focused only on differences

The system becomes more valuable as it accumulates validated experience.

  

19. Additional Capability: Code Development Sandbox

The same sandbox model should eventually extend beyond infrastructure.

A broader sandboxing ecosystem could support:

- application development;
- code generation;
- unit testing;
- integration testing;
- build validation;
- dependency testing;
- deployment simulation;
- security testing;
- infrastructure testing.

This suggests that the planning platform should not hard-code sandboxing around infrastructure.

Instead, sandbox execution may need to become a generalized platform capability.

  

20. Three Capabilities Becoming Essential

This transcript clarifies three capabilities that appear foundational rather than optional.

Capability 1 — Internet Research

The agent must be able to retrieve and analyze current authoritative information.

Capability 2 — Sandboxed Execution

The agent must be able to test its assumptions in isolated environments.

Capability 3 — Evidence-Driven Documentation

The planning system must automatically incorporate research and validation results into project artifacts.

Together:

Internet Research

        +

Sandbox Execution

        +

Evidence Capture

        ↓

Validated Planning

  

21. Revised Planning Pipeline

The evolving system could therefore use a pipeline closer to:

1. Project Intake

        ↓

2. Requirements Clarification

        ↓

3. Project Classification

        ↓

4. Research

        ↓

5. Hypothesis Generation

        ↓

6. Sandbox Provisioning

        ↓

7. Experimental Validation

        ↓

8. Failure / Remediation Loop

        ↓

9. Architecture Finalization

        ↓

10. Runbook Generation

        ↓

11. Implementation

        ↓

12. Execution Validation

        ↓

13. Lessons Learned

        ↓

14. Knowledge Promotion

This is materially different from a workflow where the system simply proceeds:

Requirements → Documentation → Runbook → Hope

  

22. Architectural Implications

The proposed capability introduces several likely system components.

Research Service

Responsible for external research and evidence collection.

Potential responsibilities:

- web search;
- documentation retrieval;
- source evaluation;
- citation capture;
- research summarization.

Sandbox Orchestrator

Responsible for creating and managing experimental environments.

Potential responsibilities:

- environment provisioning;
- execution;
- snapshots;
- resets;
- teardown;
- resource policy enforcement.

Execution Agent

Responsible for performing experiments.

Potential responsibilities:

- run commands;
- collect output;
- diagnose failures;
- iterate;
- report findings.

Evidence Store

Responsible for retaining:

- command history;
- logs;
- outputs;
- research sources;
- configuration files;
- test results.

Planning Orchestrator

Responsible for deciding when enough validation exists to advance the project.

  

23. A Critical Architectural Distinction

One important distinction should be explicitly preserved:

Research findings

≠

Validated findings

An agent locating documentation online does not prove that an implementation will work in the target environment.

Similarly:

Validated in sandbox

≠

Guaranteed in production

The system should represent different confidence levels rather than flattening everything into “known.”

A possible evidence model could include:

Unverified

Source-supported

Experimentally validated

Environment-matched validation

Production validated

That distinction would significantly strengthen the reliability of downstream automation.

  

24. Potential State Model for Technical Assertions

Technical statements could eventually be represented as structured assertions.

Example:

assertion: NVIDIA driver installation method

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

The final runbook can then be generated preferentially from high-confidence assertions.

This could prevent speculative information from silently becoming implementation instructions.

  

25. Risks Introduced by Sandboxed Autonomy

Adding sandbox execution solves several problems but introduces new ones.

Cost runaway

Agents that repeatedly provision GPU infrastructure could generate substantial cloud costs.

Resource leakage

Instances may remain running if teardown fails.

Credential exposure

Agents will require tightly scoped credentials.

Environment mismatch

A successful cloud test may produce false confidence if production differs materially.

Research drift

An agent could spend excessive time investigating low-value edge cases.

Destructive experimentation

Sandboxing must guarantee that experiments cannot reach production or unrelated resources.

These are not reasons to avoid the capability, but they imply that sandbox management must be a first-class subsystem rather than a simple shell-access feature.

  

26. New Product Principle: Separate Discovery From Execution

A stronger version of the product philosophy is emerging:

Discovery should happen in disposable environments. Execution should happen from validated instructions.

That gives the planning ecosystem two fundamentally different operational contexts.

Discovery Environment

- exploratory

- failure expected

- autonomous

- disposable

- iterative

  

Production Environment

- deliberate

- validated

- auditable

- constrained

- human-controlled when necessary

This separation may become one of the defining architectural principles of the platform.

  

27. Updated Product Thesis

The concept is evolving from an AI documentation system toward an AI-assisted engineering planning and validation platform.

Its job is not simply to determine what should be built.

Its job is to progressively transform uncertainty into evidence.

The complete progression becomes:

Idea

  ↓

Structured Requirements

  ↓

Questions

  ↓

Research

  ↓

Experiments

  ↓

Failures

  ↓

Learning

  ↓

Validated Decisions

  ↓

Executable Runbook

  ↓

Implementation Evidence

  ↓

Reusable Knowledge

A concise expression of the product thesis is:

Before asking a human or production agent to execute a plan, give the planning system the tools required to prove as much of that plan as reasonably possible.

  

28. Priority Implications

This transcript suggests a meaningful change in architectural priority.

Originally, Internet research and sandbox execution could be viewed as advanced features.

They increasingly appear to be prerequisites for trustworthy technical planning.

A likely priority ordering is therefore:

Foundational

1. Structured project state
2. Adaptive intake
3. Planning workflow orchestration
4. Evidence model

High Priority

5. Internet research
6. Sandbox provisioning
7. Agent execution
8. Validation and remediation loops

Subsequent

9. Production runbook execution
10. Automatic result monitoring
11. Cross-project knowledge reuse
12. Organizational knowledge repository

The main change is that research and experimental validation should move earlier in the roadmap.

Without them, the system may produce polished planning artifacts while still carrying unresolved implementation risk into the runbook.