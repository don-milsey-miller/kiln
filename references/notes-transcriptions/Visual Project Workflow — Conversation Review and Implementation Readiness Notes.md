# Visual Project Workflow — Conversation Review and Implementation Readiness Notes

## Purpose

This document consolidates the discussion around the current state of the **Visual Project Workflow** project, with particular focus on whether the work remains aligned with the original intent, which design questions remain unresolved, and what should be validated before implementation accelerates.

It should be read alongside the canonical planning scratchpad. The scratchpad explicitly describes itself as a thinking document rather than a specification and establishes that its decisions supersede the earlier source material.

---

# 1. What We Are Building

At a high level, the project is a **clonable, local-first project-planning system**.

A user should be able to place the planning system alongside a new project, initialize it, and work interactively through a structured planning lifecycle. The end result is not merely a collection of polished planning documents. It is intended to be an **evidence-backed implementation plan** that another team—human, agentic, or mixed—can execute without repeatedly returning to the project manager to resolve missing information.

The current North Star describes the system as a clonable planning system that moves from raw user intent through a browser-based planning lifecycle and ultimately produces a plan complete enough to hand off for execution.

The product has two major halves:

1. **The planning application**
   - Local web application.
   - Visual representation of planning stages.
   - Structured and rendered planning artifacts.
   - Status tracking.
   - Change review.
   - Linting and gates.
   - File watching.

2. **The agent system**
   - One user-facing orchestrator.
   - Research specialist.
   - Validation specialist.
   - Planning specialist.
   - Scoped context.
   - Explicit tool boundaries.
   - Structured outputs.
   - Evidence and validation workflows.

The user interacts with a single orchestrator. That orchestrator routes bounded work to specialists rather than attempting to perform every task itself.

A critical principle is that **the files and structured data are the real state**. Agent sessions and rendered documents are views or working mechanisms around that state, not replacements for it.

---

# 2. Is the Project Still Following Its Original Intent?

## Conclusion

Yes.

The recent spikes and technical investigations do **not** appear to represent scope drift. They are primarily doing what the project itself claims should happen: identifying load-bearing technical assumptions and testing them before implementation depends on them.

The important distinction is:

> The destination has remained relatively stable while some implementation mechanisms have changed because testing showed that earlier assumptions were wrong.

That is consistent with the project's own philosophy.

Examples include:

- Pi session forking was initially expected to play a larger role in specialist delegation, but verification showed it was the wrong mechanism.
- Project trust behavior was tested rather than assumed.
- Pi tool allowlists were empirically shown to form a stronger boundary than originally expected.
- The watcher spike demonstrated that `fs.watch` was unsuitable on the tested Windows environment.
- Atomic writes were demonstrated to be necessary.
- The original “partition, don't lock” solution for two writers was disproven through testing.

These are not new product goals. They are implementation assumptions being retired or strengthened.

That is arguably one of the strongest indications that the project is adhering to its intended philosophy:

> Claims important enough to carry architectural weight should be researched and, where practical, experimentally validated.

---

# 3. What the Spikes Are Actually Accomplishing

The spike work serves several purposes.

## 3.1 Turning assumptions into measured facts

The design initially contained several statements that were plausible but unverified.

The spikes have progressively converted those into evidence.

Examples include:

- Whether specialist child agents receive the intended custom tools.
- Whether tool allowlists actually prevent unauthorized capabilities.
- Whether hooks execute in non-interactive child sessions.
- Whether locally installed Pi packages are referenced or copied.
- Whether skill precedence behaves as expected.
- Whether file watchers behave reliably under burst writes.
- Whether atomic replacement prevents partial reads.
- Whether multiple processes can safely edit different portions of the same physical file.

The project document itself distinguishes between things learned from reading documentation and things proven by running them. That distinction is important and should continue.

## 3.2 Invalidating mechanisms without invalidating goals

Several experiments have disproved implementation ideas while preserving the larger architecture.

For example:

- Multi-agent delegation remains valid.
- Session forking as the delegation mechanism does not.
- File watching remains valid.
- `fs.watch` as the watcher does not.
- Two actors modifying planning state remains valid.
- “Partition different regions inside one file” does not.

That is healthy architectural refinement rather than instability.

---

# 4. Remaining Questions That Affect Implementation

The discussion identified three primary unresolved or incompletely verified areas.

They are not all the same type of problem.

One is a genuine design decision.

The others are closer to implementation validation.

---

# 5. Open Issue One — Two Writers and One Document

This is the most substantial remaining architectural decision.

## The original assumption

The earlier design proposed:

> Partition, don't lock.

The idea was roughly:

- The application writes frontmatter and lightweight state.
- The agent writes prose or structured content.
- Since each writer conceptually owns a different region, they should not conflict.

The watcher spike demonstrated that this mental model does not match filesystem behavior.

A process cannot generally update only “its section” of a Markdown or MDX file.

It typically performs:

1. Read entire file.
2. Modify its portion in memory.
3. Write entire file back.

If another process performs the same sequence concurrently, both writes contain snapshots of the whole file.

Therefore:

> The ownership regions are separate conceptually but the physical write operations overlap completely.

The spike found:

- Non-atomic concurrent writes caused corruption.
- Atomic writes prevented corruption but still lost updates.
- Stat-based compare-and-swap reduced but did not eliminate races.
- A lockfile survived testing.
- Separate state files also survived testing.

---

# 6. The Two Viable Candidates

## Option A — Short-Lived Lockfile

The first option is an exclusive lock around each read-modify-write operation.

The important point is that this is **not** a lock held while the agent is thinking or throughout an entire turn.

The lock exists only around something approximately shaped like:

```text
acquire lock
    ↓
read current file
    ↓
apply modification
    ↓
write temporary file
    ↓
atomic rename
    ↓
release lock
```

### Advantages

- The planning document remains one logical and physical object.
- Status may continue living in frontmatter.
- Existing readers need only one document.
- The tracker does not need to reconcile multiple sources.
- The handoff does not need to stitch state back together.
- The lint system can reason about one document.
- The design remains consistent with the existing decision that per-document state belongs with the document.

### Costs

A coordination mechanism must exist.

Every legitimate writer must obey it.

The system also needs safe behavior around:

- lock acquisition retries,
- stale locks,
- crashed writers,
- ownership identification,
- bounded wait periods,
- cleanup,
- Windows-specific filesystem behavior.

### Important qualification

The earlier objection to locking assumed that the document might remain locked throughout a long agent operation.

That is not the candidate being considered now.

A short-lived write lock is fundamentally different.

---

# 7. Option B — Sidecar State Files

The second option is to move application-owned state into a separate file.

For example:

```text
05-solution-design.mdx
05-solution-design.state.json
```

The agent owns the MDX document.

The application owns the state file.

Filesystem-level ownership becomes unambiguous.

### Advantages

- The app never rewrites the agent's document.
- The agent never rewrites the app's state.
- No coordination protocol is required between those two writers.
- The operating system enforces the boundary because the writers modify different files.
- Concurrent writes cannot clobber each other unless ownership rules themselves are violated.

### Costs

The system now has two pieces of information representing what users mentally perceive as one document.

Every consumer that needs the complete document state must combine them.

Potential consumers include:

- tracker,
- renderer,
- lint,
- handoff generation,
- stage gates,
- change feeds,
- migration tooling.

That moves complexity away from the write path and into the rest of the architecture.

### Deeper concern

The sidecar approach can create consistency problems.

Examples:

```text
document exists
state file missing
```

or:

```text
document was renamed
state file retained old name
```

or:

```text
document reverted in Git
state file was not
```

Therefore the concurrency problem becomes a reconciliation problem.

---

# 8. Current Recommendation — Prefer the Lockfile

The discussion favored the **short-lived lockfile**.

The reasoning is not simply that locks are easier.

It is that the lockfile preserves an existing architectural property:

> One document remains one object.

The sidecar solves concurrency elegantly but introduces permanent dual-state complexity into every reader.

The lockfile introduces complexity in one place: the write path.

That trade appears preferable at the current scale.

A reasonable implementation would therefore be:

```text
exclusive lock
    +
fresh read after lock acquisition
    +
apply mutation
    +
temporary file
    +
atomic rename
    +
bounded retry
    +
release lock
```

The already-decided atomic-write behavior remains necessary regardless.

---

# 9. A Separate Problem Discovered During the Discussion — Semantic Staleness

An important distinction surfaced during the concurrency discussion.

Even if the lockfile completely solves simultaneous writes, it does **not** solve the case where an agent makes decisions using information that has since changed.

Example:

```text
Agent A reads Requirement R1
Agent B reads Requirement R1

Agent A changes R1
Agent B continues working from the old R1
```

Agent B may later produce a perfectly safe filesystem write that is nevertheless logically obsolete.

This is not a file-locking problem.

It is a **semantic freshness problem**.

The conversation initially considered Git-like merging as a possible solution.

Git is useful as an analogy but does not directly solve this system's problem because the required behavior is not merely textual conflict resolution.

The important question is:

> Has the state on which this agent based its work changed since that work began?

A future mechanism could potentially associate work with artifact revisions or source versions.

For example:

```text
planning task:
  requirement: R1
  based_on_revision: 17
```

Before committing the result:

```text
current revision of R1 = 19
```

The system could then decide that the specialist output requires reevaluation.

This resembles optimistic concurrency at the artifact level.

## Decision from the discussion

Do **not** expand the current implementation scope to solve this immediately.

The existing traceability and cascade machinery already provides conceptual foundations for dealing with changes.

First implement the simpler write-safety mechanism.

Then observe real agent contention.

If stale-context failures appear, introduce artifact-level version awareness based on evidence rather than speculation.

This should be explicitly remembered, but it does not need to block the walking skeleton.

---

# 10. Open Issue Two — Project Trust for Specialist Children

The second issue is substantially narrower.

The spike already established the important fact:

> A non-interactive Pi child without the relevant project trust may start normally while silently lacking the project package and typed tools.

That failure mode is especially dangerous because the child does not necessarily crash.

It can appear healthy while having lost the mechanisms that enforce the specialist contract.

The document records this behavior as an empirical finding.

## What is already known

The spike showed that:

- untrusted child → extension absent,
- `--approve` → extension loads,
- explicitly loading the extension → extension loads.

Therefore trust was proven to be the controlling variable.

## What has not been proven

The selected production design is for setup to record the PM's trust decision in:

```text
~/.pi/agent/trust.json
```

The document explicitly notes that this specific path has not yet been exercised end-to-end.

Therefore the remaining task is not really architecture design.

It is a **small verification spike**.

---

# 11. Proposed Trust Spike

A minimal experiment should reproduce exactly what the production setup will do.

## Test

1. Create a clean test project.
2. Ensure default project trust is restrictive.
3. Install the planning package locally.
4. Launch a non-interactive child.
5. Confirm typed tools are absent.
6. Write the intended project trust entry exactly as the setup script would.
7. Launch the same child again.
8. Confirm:
   - extension loaded,
   - expected custom tools registered,
   - no `--approve` override required.
9. Remove the trust entry.
10. Confirm the child returns to the untrusted behavior.

The result is binary.

### Pass

The current decision survives.

### Fail

Revisit the mechanism.

Existing fallbacks are already known to work, so failure would not threaten the multi-agent architecture.

---

# 12. Why `--approve` Is Not the Preferred Permanent Solution

The conversation reinforced an important governance principle.

Automatically spawning every child with `--approve` would be operationally easy.

But it would mean the planning extension overrides the user's own trust policy.

That is materially different from the PM explicitly granting trust once during setup.

The preferred model therefore remains:

```text
PM grants permission
        ↓
permission is recorded
        ↓
children inherit that decision
        ↓
delegation verifies required tools exist
        ↓
missing tools = loud failure
```

The last step is especially important.

Even with a recorded trust decision, delegation should verify its assumptions rather than trusting configuration implicitly.

---

# 13. Open Issue Three — Skill Overrides

The project intends to ship default skills while allowing a PM to customize individual ones without modifying the tool repository itself.

The conceptual model is:

```text
packaged skill
      ↓
optional project override
      ↓
override wins
```

The precedence behavior itself has been demonstrated using Pi's native `.pi/skills/` discovery path.

The unresolved part is the proposed location:

```text
planning-content/skills-overrides/
```

That directory is not inherently a Pi discovery location.

The canonical document explicitly warns that the desired override precedence exists, while the proposed path may not actually produce it.

---

# 14. Proposed Skill-Override Spike

This should also be a small experiment.

Create:

```text
packaged skill:
  output = "PACKAGED"

override skill:
  output = "OVERRIDE"
```

Test whichever production mechanism is being considered.

Then inspect which implementation Pi actually loads.

The goal is not to prove that Pi supports overrides in general.

That is already known.

The test must prove:

> The exact directory and registration mechanism this product plans to ship results in the override winning.

Possible outcomes include:

### Outcome A

`planning-content/skills-overrides/` works through explicit registration and precedence behaves correctly.

Keep the design.

### Outcome B

Explicitly registering that directory causes packaged skills to win.

Move user overrides into:

```text
.pi/skills/
```

or have setup materialize them there.

### Outcome C

Another clean loading mechanism exists.

Record it as the decided production behavior.

This question should be closed before a public customization story is documented.

---

# 15. Implementation Risk One — The Evidence Loop Has Not Yet Been Proven End-to-End

The discussion then moved from unresolved architecture into implementation risks.

The largest one is the **evidence loop**.

The project makes an unusually strong claim:

> Planning output should distinguish between assumptions, source-supported claims, experimentally validated claims, and environment-matched claims.

The confidence model is central to this.

A simplified version of the intended flow is:

```text
requirement
    ↓
technical assertion
    ↓
research
    ↓
source-supported evidence
    ↓
validation task
    ↓
sandbox experiment
    ↓
observed evidence
    ↓
confidence rung
    ↓
planning decision
    ↓
runbook instruction
```

That chain is arguably the most novel capability in the entire project.

Yet the current early build work primarily proves the **authoring loop**.

The first schema group intentionally focuses on:

```text
requirement
decision
schema
api-spec
```

That is useful because it exercises:

- schemas,
- typed tools,
- templates,
- lint,
- tracing,
- rendered artifacts.

But it does not prove:

```text
assertion
evidence
confidence
validation
runbook-step
```

The canonical document itself calls out this limitation.

---

# 16. Recommendation — Add a Thin Evidence Vertical Slice Earlier

Rather than implement the entire evidence catalogue immediately, test one claim all the way through.

The goal is not feature completeness.

The goal is to answer:

> Does the core evidence model actually feel coherent when all of its pieces interact?

A vertical slice should include exactly one meaningful technical assertion.

---

# 17. Example Evidence Vertical Slice

A hypothetical assertion might be:

```text
Assertion A-001:
PostgreSQL 17 logical replication supports requirement R-012
under the selected deployment topology.
```

The exact technical topic does not matter.

The experiment should be meaningful but cheap enough that the workflow, rather than the infrastructure, remains the thing being tested.

## Step 1 — Requirement

```yaml
id: R-012
statement: The system must replicate selected data between environments.
```

## Step 2 — Assertion

```yaml
id: A-001
statement: PostgreSQL 17 logical replication satisfies R-012.
confidence: unverified
traces_to:
  - R-012
```

## Step 3 — Research

The research specialist examines authoritative documentation.

Result:

```yaml
confidence: source-supported
```

Evidence records the relevant sources.

## Step 4 — Determine Whether the Claim Is Load-Bearing

If the architecture depends on this working, research alone is insufficient.

A validation task is raised.

## Step 5 — Validation

The validation specialist provisions the cheapest environment capable of answering the question.

It:

- configures the environment,
- executes the procedure,
- captures commands,
- records versions,
- captures output,
- records success or failure.

## Step 6 — Assertion Updated

Successful validation might result in:

```yaml
confidence: experimentally-validated
```

or:

```yaml
confidence: environment-matched
```

depending on fidelity.

## Step 7 — Planning Agent Consumes It

The planning agent uses the evidence-supported assertion when creating the implementation or runbook artifact.

## Step 8 — Lint

The lint verifies:

```text
runbook step
    ↓
has backing assertion
    ↓
assertion has evidence
    ↓
confidence meets step threshold
```

## Step 9 — Render

The application displays:

- assertion,
- confidence rung,
- supporting evidence,
- runbook step,
- trace chain.

If this single example works naturally, a large part of the conceptual architecture has been validated.

If it is awkward, redundant, difficult to trace, or overly expensive, that should be learned before sixteen schemas and nine stages harden around it.

---

# 18. Why the Evidence Slice Matters More Than Another UI Feature

The application interface is important.

But the evidence model is much closer to the project's distinguishing idea.

Without it, the system risks becoming:

> A sophisticated documentation interface for AI-generated planning.

With it, the intended proposition becomes:

> A planning system that knows which implementation claims are guesses, which are documented, which have been experimentally tested, and which are safe enough to become instructions.

The latter is significantly more defensible.

Therefore, proving that loop early is high-leverage.

---

# 19. Implementation Risk Two — Run the Methodology on This Project Itself

The current build order calls for running stages 1 and 2 on the Visual Project Workflow project before the walking skeleton is completed.

This should not be treated as administrative housekeeping.

It is an experiment on the **methodology itself**.

The project is effectively saying:

> Before we encode our planning process in software, use the planning process honestly and see whether it works.

That is unusually valuable.

---

# 20. What Stage 1 Should Test

Stage 1 should answer whether the intake model can represent this project without prematurely encoding its solution.

Questions include:

- What is the actual project objective?
- Who is the user?
- What counts as successful handoff?
- What constraints are real?
- Which assumptions are already embedded in the current architecture?
- Which decisions are preferences rather than requirements?
- What explicitly does not belong in v1?

If the intake stage immediately feels artificial because the answers already live in the scratchpad, that itself is useful feedback.

The future system will often be introduced into projects that already contain partial thinking.

The methodology must handle that reality.

---

# 21. What Stage 2 Should Test

Stage 2 is especially important because it determines:

- structured requirements,
- scope boundaries,
- explicit non-goals,
- glossary,
- artifact activation.

The existing project currently proposes an initial set of artifact types for the first implementation slice.

But according to its own methodology, artifact activation should emerge from stage 2 and receive PM approval.

Therefore stage 2 creates a direct test:

> Does the process independently produce the artifact types the architecture already assumes?

Three outcomes are possible.

### It produces the same set

Good evidence that the design and methodology agree.

### It produces a different set

That is not a failure.

It means the methodology found something the architecture had pre-decided.

### It struggles to make the decision at all

That may indicate the stage definition or artifact activation mechanism is underspecified.

This is exactly the kind of finding that should occur before the UI automates the process.

---

# 22. Implementation Risk Three — Schemas Are the Real Critical Path

A recurring theme throughout the conversation and scratchpad is that the application itself may look like the largest engineering task while the real critical path is the artifact system.

The current catalogue contains sixteen artifact types.

Each structured artifact eventually requires some combination of:

```text
schema
typed writer
lint rules
trace behavior
materiality metadata
renderer
template integration
handoff serialization
migration behavior
```

Therefore “one schema” is not just a JSON Schema file.

It is effectively part of a distributed contract shared by most of the system.

---

# 23. Why Schema Decisions Have Large Blast Radius

Consider a requirement artifact.

Its schema influences:

```text
typed tool input
        ↓
stored representation
        ↓
lint
        ↓
traceability
        ↓
cascade
        ↓
templates
        ↓
application renderer
        ↓
handoff
```

A schema decision made casually in step 3 can therefore propagate into nearly every later system.

That is why the decision to use JSON Schema as the authoritative representation is important.

The canonical design now uses:

> JSON Schema as the source of truth, with TypeScript types generated from it.

The rationale is sound because the schema needs to behave as data, not merely executable validation code.

---

# 24. Practical Recommendation for Schema Development

Do not attempt to design all sixteen artifacts to completion before learning from the first few.

Use the initial schemas to prove shared patterns.

A good first group is already identified:

```text
requirement
decision
schema
api-spec
```

Treat these four as the testbed for:

- ID conventions,
- trace link representation,
- status representation,
- materiality metadata,
- `n/a`,
- unresolved links,
- validation errors,
- migration strategy,
- template generation,
- renderer interfaces.

Once those conventions feel stable, subsequent schemas become application of a pattern rather than sixteen unrelated design exercises.

Then introduce the evidence vertical slice early enough that those conventions are challenged by:

```text
assertion
evidence
runbook-step
```

Those artifact types stress different parts of the architecture.

---

# 25. Recommended Near-Term Sequence

Based on the discussion, a practical sequence would be:

## 1. Close the file-write decision

Choose:

```text
short-lived lockfile + atomic write
```

unless implementation reveals a concrete reason to prefer sidecars.

Document the decision formally as the successor to #31.

## 2. Run the project-trust verification

Do not redesign the mechanism unless the spike disproves it.

## 3. Run the skill-override verification

Settle the actual production path and precedence.

## 4. Implement the first four schemas

Use them to stabilize the common artifact conventions.

## 5. Run stages 1 and 2 manually on this project

Treat the result as methodology validation.

Do not force it to reproduce the existing architecture.

## 6. Build the walking skeleton

Prove:

```text
manifest
    ↓
tracker
    ↓
one planning document
    ↓
structured artifact
    ↓
render
    ↓
status write
    ↓
file watcher
    ↓
lint feedback
```

## 7. Add one evidence vertical slice early

Prove:

```text
requirement
    ↓
assertion
    ↓
research
    ↓
validation
    ↓
evidence
    ↓
confidence
    ↓
runbook step
    ↓
lint
```

## 8. Only then broaden the catalogue and specialist behaviors

At that point the system will have proved both of its central loops:

### Authoring loop

```text
structured state → document → app → modification → lint
```

### Evidence loop

```text
claim → research → validation → evidence → confidence → instruction
```

Together, those are much closer to a legitimate vertical proof of the product than either one alone.

---

# 26. What Should Not Be Added Yet

The conversation also identified several things that are worth remembering but should not immediately become implementation scope.

## Artifact revision / semantic freshness

Likely useful eventually.

Do not build until real concurrent agent work demonstrates the need.

## Git-style merging

Useful conceptual analogy.

Not currently the right mechanism for coordinating high-frequency agent state changes.

## Additional agents

The current orchestrator plus three specialists is already enough architecture to validate.

Do not add a reviewer/governor until there is actual evidence that the PM plus linting is insufficient.

## Live runbook execution

Remains explicitly outside the product boundary.

The system produces executable planning instructions.

It does not monitor their execution.

## Large-scale knowledge systems

Still several product layers beyond the MVP.

---

# 27. Overall Assessment of Implementation Readiness

The project appears to have passed an important transition.

Earlier work was primarily about:

> What should this system be?

The remaining work increasingly looks like:

> Does the mechanism behave the way the architecture requires?

That is a positive sign.

There are still meaningful architectural risks, but they are increasingly concrete and testable rather than philosophical.

The most important remaining work is therefore not additional broad ideation.

It is to systematically convert the remaining assumptions into either:

```text
measured fact
```

or:

```text
deliberate product decision
```

and then build.

---

# 28. Current Decision / Validation Matrix

| Topic | Current state | Next action |
|---|---|---|
| Overall product intent | Stable | Build against it |
| Multi-agent roster | Decided | Implement contracts |
| Specialist tool boundaries | Empirically validated | Enforce `tools:` lint |
| File watcher | Decided | Use chokidar |
| Atomic writes | Decided | Implement in every typed writer |
| Two writers / one document | **Open design decision** | Prefer short-lived lockfile; record decision |
| Semantic stale reads | Identified, not yet blocking | Revisit after real concurrency |
| Project trust | Design selected, mechanism incompletely verified | Run focused trust spike |
| Skill override location | Concept validated, path unresolved | Run focused override spike |
| Initial schema representation | Decided | JSON Schema → generated TS |
| First artifact slice | Decided | Build four schemas |
| Methodology itself | Unproven in real use | Run stages 1–2 on this project |
| Authoring loop | About to be implemented | Walking skeleton |
| Evidence loop | Conceptually strong, not end-to-end proven | Add thin vertical slice |
| Full catalogue | Designed at high level | Expand after core patterns prove |
| Runbook production | In scope | Build after evidence loop |
| Runbook execution | Out of scope | Do not implement |

---

# 29. Recommended Principle Going Forward

The conversation repeatedly returned to one useful discipline:

> Do not solve speculative problems before the implementation produces evidence that they are real, but do not allow load-bearing assumptions to remain untested merely because they look plausible.

That gives the project a practical decision rule.

For each new concern:

```text
Does this block the next implementation step?
        │
        ├── yes → decide or spike now
        │
        └── no
             ↓
Would being wrong force major architectural rework?
        │
        ├── yes → run a cheap validation now
        │
        └── no → record it and keep building
```

This protects the project from two opposite failure modes:

1. **Premature architecture**
   - solving problems that may never occur.

2. **Wishful implementation**
   - building on assumptions that would be expensive to discover later.

The existing trust and watcher spikes are strong examples of the second category being handled correctly.

---

# 30. Final Position

The project does **not** currently look as though it is wandering out of scope.

The technical spikes are generally reinforcing the intended product philosophy rather than distracting from it.

The main architectural issue still deserving an explicit decision is the successor to #31.

The most aligned choice currently appears to be:

> **Short-lived exclusive lock around read-modify-write operations, combined with the already-decided atomic temp-file-plus-rename write strategy.**

Two narrow verification spikes remain valuable:

- project trust,
- skill override path.

The main implementation caution is that a working UI and structured authoring loop would not, by themselves, prove the product's most differentiated capability.

A thin evidence slice should therefore be exercised relatively early.

Finally, running stages 1 and 2 of the methodology against this project itself should be treated as a real validation experiment rather than a prerequisite checkbox.

Once those items are addressed, the project is increasingly in a state where **building will answer more useful questions than additional abstract design discussion**.