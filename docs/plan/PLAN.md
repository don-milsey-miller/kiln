# Plan

Generated. Every claim below links to what it rests on.

## Requirements

### REQ-0001 — The planning process is defined by the system, not by the session

The system must define the sequence of planning activities and their completion conditions, such that two planning sessions on comparable projects follow the same sequence.

*Priority: must*

### REQ-0002 — Current project state is inspectable at any time

At any point the system must be able to report which stage the project is in and what that stage still requires.

*Priority: must*

### REQ-0003 — Implementation questions can be answered from current external sources

When a planning question depends on external fact, the system must be able to consult a current external source rather than reason from what it already holds.

*Priority: must*

### REQ-0004 — A claim taken from a source records that source

Any claim the plan rests on that came from an external source must record a reference to that source.

*Priority: must*

### REQ-0005 — Claims can be tested by execution in a real environment

The system must be able to execute a procedure in a real environment and capture the commands run, the output produced, and whether it succeeded.

*Priority: must*

### REQ-0006 — A tested claim records the environment it was tested in

Any claim validated by execution must record the environment it ran in, in enough detail to judge whether that environment resembles the target.

*Priority: must*

### REQ-0007 — Every load-bearing claim carries how it is known

Every claim the plan depends on must carry a recorded basis — unverified, source-supported, or demonstrated by execution — as structured data rather than prose.

*Priority: must*

### REQ-0008 — A reader can distinguish claim strength without reading prose

A reader or a consuming agent must be able to tell the basis of any claim by inspecting structure, without interpreting narrative text.

*Priority: must*

### REQ-0009 — Instructions rest on resolved claims

No instruction in the final output may rest on a claim whose basis is below the level required for that instruction.

*Priority: must*

### REQ-0010 — The handoff is actionable without returning to the planner

A recipient of the output must be able to begin their part of the work without asking the planner for information the plan should have contained.

*Priority: must*

### REQ-0011 — The output serves a human or an agent implementer

For every required item in the handoff, both a human reader and an automated consumer must be able to recover the same information without depending on the other representation.

*Priority: must*

### REQ-0012 — Validation that costs money or needs credentials requires explicit authorisation

The system must not perform a validation that incurs cost or uses credentials unless the operator has explicitly authorised that class of validation.

*Priority: must*

### REQ-0013 — Decisions are recorded with their alternatives

Every decision that shapes the plan must be recorded together with the options considered and why the chosen one won.

*Priority: should*

### REQ-0014 — Open questions are tracked objects, not prose

An unresolved question must exist as a tracked item with a state, not as a sentence inside a document.

*Priority: should*

## Components

### CMP-0001 — Stage definitions and the gate

Defines the pipeline's stages, what each produces, and evaluates whether a stage may be exited.

*Satisfies: REQ-0001, REQ-0002*
*Implemented by: stages/*.json, lib/stages.mjs, lib/lint.mjs, lib/attestations.mjs*

### CMP-0002 — The lint

Checks storage identity, trace integrity, content completeness, lifecycle and instruction safety across all artifacts, and blocks at the two boundaries #46 names.

*Satisfies: REQ-0002, REQ-0009*
*Implemented by: lib/lint.mjs, bin/lint-plan.mjs*

### CMP-0003 — Artifact store

Persists one artifact per file, resolves the content root, and serialises every read-modify-write so concurrent writers cannot destroy each other.

*Satisfies: REQ-0002*
*Implemented by: lib/layout.mjs, lib/content-root.mjs, lib/atomic-write.mjs, lib/lock.mjs, lib/id-allocator.mjs*

### CMP-0004 — Schema layer

Owns the artifact schemas, their composition through one envelope, and the effective-schema resolution every consumer reads materiality from.

*Satisfies: REQ-0007, REQ-0008*
*Implemented by: schemas/, lib/schema-resolver.mjs, lib/validate.mjs, lib/template.mjs*

### CMP-0005 — Typed tools

The only way an artifact is created or mutated (#88), including the guards that make each transition refusable.

*Satisfies: REQ-0013, REQ-0014*
*Implemented by: lib/tools/*

### CMP-0006 — Research capability

Discovers and retrieves public external sources through a typed interface, refuses when unavailable, and never answers from model memory.

*Satisfies: REQ-0003, REQ-0004*
*Implemented by: lib/research/, bin/research.mjs, bin/research-probe.mjs*

### CMP-0007 — Validation controller

Runs declared jobs under a tier-1 sandbox through provision-execute-observe-destroy, refuses jobs above the approved ceiling before provisioning, and records what was observed including cleanup outcome.

*Satisfies: REQ-0005, REQ-0006, REQ-0012*
*Implemented by: lib/validation/*

### CMP-0008 — Evidence derivation

Derives verdict and confidence from the evidence graph at read time, filtering for applicability first, and decides whether a claim may become an instruction.

*Satisfies: REQ-0007, REQ-0008, REQ-0009*
*Implemented by: lib/effective-assertion.mjs*

### CMP-0009 — Specialist contracts

Describes each role's measured capabilities, write boundary and credential scope, and refuses a child's output that cannot demonstrate them.

*Satisfies: REQ-0012*
*Implemented by: lib/specialists/contract.mjs*

### CMP-0010 — Reader surface

Renders the derived view of artifacts for a human, and reflects external writes without a reload.

*Satisfies: REQ-0002, REQ-0011*
*Implemented by: app/server.mjs, lib/view/assertion-view.mjs*

### CMP-0011 — Handoff export

Produce the frozen handoff package under docs/plan/ from planning-content, on an explicit deterministic command, such that a recipient can begin their part of the work without asking the planner for information the plan should already contain.

*Satisfies: REQ-0010, REQ-0011*
*Implemented by: bin/handoff.mjs, lib/handoff/publish.mjs, lib/handoff/render.mjs, lib/handoff/completeness.mjs, test/handoff.test.mjs*

## Decisions

### DEC-0001 — Adopt Next.js when product UI work begins, not as cleanup

Do not migrate the walking skeleton to Next.js as cleanup. When product UI work begins, build the product shell in Next.js, carrying forward the validated watcher/SSE/write-back contract. Migration is feature work, not framework conformity.

**Why:** The skeleton was framework-free because #5's choice was untested; QST-0004 has now tested it, including the surface the skeleton deliberately left open. Nothing forces a migration — the framework-free server already does what Next.js was validated to do. What Next.js buys is product: MDX rendering, the interactive components #54 wants, and #19's site/ build path. Migrating for its own sake would trade a working proof of the risky substrate for no capability.

### DEC-0002 — What makes a requirement gap BLOCKING

An unresolved question is blocking when proceeding would require a load-bearing commitment whose correctness materially depends on its answer, or when its absence makes the current stage's exit criterion unevaluable. Missing implementation alone is work, not a gap.

**Why:** Stage 4's exit criterion turns on the word and the stage table never defined it, so the stage could not be exited honestly in either direction. The definition separates the two things that were being conflated: a decision whose absence would make the next commitment possibly wrong, and work that is simply not done. The second clause is self-referential on purpose — a question that makes a criterion unevaluable blocks by construction, which is what QST-0009 itself was.

### DEC-0003 — A specialist contract may only describe capabilities the host can supply AND detect

Every capability named in a specialist contract must be one the host can actually provide and can verify is present. Where a named capability is unavailable, the specialist must produce an explicit refusal or a recorded gap — never proceed by guessing.

**Why:** #67 measured the failure this prevents: a trust-denied child completed a normal-looking session with the typed tools absent and nothing reported it. #81 answered that for tools specifically, with a capability check before any output is accepted. This generalises it: research and sandboxing are capabilities in exactly the same sense, and a research specialist with no search, or a validation specialist with no sandbox, fails the same way — plausible prose in place of an answer. Detectability is the load-bearing half: a capability the host cannot check is one the contract cannot honestly promise.

### DEC-0004 — Research capability is a typed extension interface, not a vendor

The shipped Pi extension owns a stable, typed research interface — `research_search`, `research_fetch`, `research_capability` — and the research specialist depends on THOSE capabilities, never on a search vendor, model provider or arbitrary MCP tool name. An MCP server may sit behind the extension as an adapter; it must not become the specialist contract. Boundary: public, read-only internet research is permitted when a delegated question depends on a current external fact. Authenticated or private sources, purchases, submissions and other side effects are unavailable unless separately activated later. Credentials live in the PM's host environment, outside the repository and the planning content; the extension consumes them and they are never placed in a child prompt or returned in tool output. Every delegation probes tool registration AND backend health/authentication — installed-but-unusable is unavailable. Search results are discovery observations, not automatically evidence: a fetched source supporting a recorded claim must become evidence(kind: source) carrying URL, retrieval time, source metadata and a retained citation. If search or retrieval is unavailable the specialist returns a structured capability refusal and records the gap, and MUST NOT answer from model memory.

**Why:** This answers QST-0005 at the level DEC-0003 requires: a capability the host can supply AND detect. Naming three typed tools rather than a backend makes the contract falsifiable — the specialist can be asked whether it has research, and the answer is a probe result rather than an assumption. Pi has no built-in MCP and its extension API registers custom tools, so the adapter layer is where a vendor belongs; a contract written against vendor tool names would change every time the backend did, which is #67's toolless child arriving through the supply chain instead of through trust. The refusal clause is the load-bearing half: the intake's problem 2 was 'educated guessing', and a research specialist that answers from model memory when retrieval is down reproduces exactly that failure while looking like success. Discovery-is-not-evidence keeps #123's boundary intact at the point new observations enter — a search hit is an observation about what exists, not an observation about the claim.

### DEC-0005 — Tier 1 first, through a typed validation controller with an honest boundary

Build tier 1 first, since #77 already makes it the default. The shipped extension provides a typed validation controller; the specialist NEVER receives unrestricted shell execution. A validation job declares: required tier and capabilities; input files or hashes; commands as an ARGUMENT ARRAY, never an interpolated shell string; a capture plan; timeout and output limits; expected outputs; and any network, credential or cost requirement. The controller owns provision -> execute -> observe -> destroy and refuses a job BEFORE provisioning if it exceeds the project's approved ceiling. Tier 1 is a fresh temporary workspace and Python virtual environment. Its boundary is stated, not implied: a virtual environment isolates Python dependencies; it is NOT an OS security sandbox. Tier 1 therefore does not claim to contain hostile code, deny host-filesystem access or enforce network isolation; it supplies no credentials and uses an allowlisted process environment, and is suitable only for trusted, non-destructive validation that does not need those guarantees. Claims requiring real containment, OS/package fidelity, credentials or external infrastructure require a higher tier. Every run produces an observation record: commands, inputs, outputs, exit status, timing, versions, environment facts, permission failures and cleanup outcome. The capture plan makes omission states DETECTABLE — `not captured` (collection deliberately disabled), `not observable` (no available collector), `unavailable` (collection ran, fact absent), `redacted` (obtained, policy suppressed) — each requiring a reason. Unrequested facts remain simply absent. These describe the OBSERVER only; bearing, applicability, verdict and confidence stay claim-relative (#123). Cleanup failure is a first-class run result: preserve the evidence, report the retained path, and never present destruction as successful.

**Why:** This answers QST-0006 by settling boundaries before mechanism, as DEC-0003 requires. Four things make it a contract rather than an intention. (1) The honest tier-1 boundary: a venv called a sandbox would let a claim inherit containment it never had, and every claim validated in tier 1 would carry a strength nothing earned. Naming what tier 1 does NOT do is what keeps the rung ceiling truthful. (2) Argument arrays rather than shell strings remove a whole class of interpolation defect at the type level rather than by review. (3) The four omission states are exactly what #122 said the schema needed and #123 said it must not exceed: each is a fact about the observer, none is a judgement about a claim, and each is stated only because a capture plan can actually distinguish it — a state nothing can detect would repeat #121's error one layer down. (4) Cleanup failure as a first-class result closes the gap where a destroy step that silently failed would leave the record saying the environment was gone. Refusal before provisioning is what makes #77's authorisation real: a ceiling checked after spending is a report, not a control.

### DEC-0006 — Tavily is the first research adapter, with a stated credential and public-web boundary

The first adapter behind DEC-0004's typed interface is the Tavily Search API. Basic search is configured with search_depth 'basic', auto_parameters false, include_answer false and include_raw_content false, and returns discovery results only. GET /usage is the capability probe: it validates authentication and reports remaining quota WITHOUT performing a search. CREDENTIAL CONTRACT: the PM creates the account and supplies TAVILY_API_KEY through the host environment; it is injected only into the research child, never into planning or validation children; the specialist has no shell and no generic environment-reading tool; the extension reads the key but never places it in prompts, logs, errors or tool results; and missing key, failed authentication, exhausted quota and an unreachable backend each produce a DISTINCT unavailable reason. PUBLIC-WEB BOUNDARY on research_fetch: reject non-HTTP(S) schemes, URLs carrying credentials, loopback/private/link-local destinations, and oversized or unsupported responses, and revalidate EVERY redirect. Tavily discovers candidate URLs; the project's own guarded fetch reads the authoritative page; neither becomes evidence until the specialist records the fetched source through the typed evidence path.

**Why:** Tavily fits REQ-0012 better than the alternatives for a specific reason: its free plan grants 1,000 monthly credits with no payment card and STOPS when exhausted, so the authorisation ceiling is enforced by the plan rather than by the PM watching a bill. GET /usage is what makes the capability probe meaningful — DEC-0003 requires a capability the host can DETECT, and a backend that could only be tested by performing a search would charge a credit to answer 'are you there'. Fixing the spend-relevant search parameters in the adapter rather than exposing them keeps cost predictable at one credit per search, which is a REQ-0012 control and not a default. The public-web boundary is the sharper half: a fetch tool with no destination boundary is not a research capability but a request forger inside the host — 169.254.169.254 is cloud metadata and localhost is whatever the PM is running — so DEC-0004's 'public, read-only' scope needed a mechanism rather than a sentence. Revalidating every redirect is what makes the boundary hold, since checking only the URL the caller supplied inspects the doormat and lets the server choose the destination.

### DEC-0007 — Tier is a permission and execution boundary, not an epistemic rank

There is NO global isolation-to-confidence cap. Sandbox tier describes how execution was provisioned and what boundary it supplied; confidence describes how well applicable evidence matches a particular claim. A host run may legitimately reach environment-matched for a claim specifically about that host, and tier 1 cannot lift an OS-containment claim merely because a virtual environment existed. `isolationBoundary` therefore enters the same claim-relative comparison as every other environment fact, via the assertion's `requiresIsolation`: required and matched may reach environment-matched; required but absent is unknown and capped; required and incompatible means the evidence does not apply to that claim; not required by the claim carries no penalty at all. The older 'tier determines the confidence ceiling' language is AMENDED rather than implemented.

**Why:** QST-0013 looked like a missing implementation and was actually a category error preserved in the wording. Building the cap would have made two axes into one and produced wrong answers in both directions: it would have penalised AST-0013 — a claim about the PM's host, evidenced by a run on that host, where the absence of isolation is not a shortfall but an irrelevance — and it would have rewarded a tier-1 run for a containment claim tier 1 explicitly does not support. Routing isolation through the existing three-state comparison keeps one mechanism where there might have been two, and it makes DEC-0005's `doesNotClaim` list load-bearing: an explicit denial is a CONTRADICTION of a requirement, where silence is only unknown. The neutral 'not-required' state is the part most easily got wrong — collapsing it into 'unknown' would reintroduce the global penalty in different words, by capping every claim that never asked about isolation.

### DEC-0008 — `component` joins the catalogue as CMP and is activated on this project

`component` joins the v1 catalogue with prefix CMP and is approved for activation here. Minimal shape: a named design unit (the envelope's title), a `responsibility`, `satisfies` links to requirements, and the standard lifecycle/review envelope. Additional links wait for authentic stage 7-8 demand. Separately: a stage's `produces[]` is a CAPABILITY ENVELOPE across project types, and the applicable set for a particular project is `produces[] INTERSECT activatedTypes`. Activation describes the project type; the stage definition owns where an applicable type is produced. `component` is added to stage 5's produces; `schema`, `api-spec` and `wireframe` are RETAINED, because the stage 5 run showed them inapplicable here rather than invalid globally.

**Why:** The #41 case is conclusive rather than speculative: `component` owns irreducible many-to-many design state that a requirement cannot hold, and four independent consumers were already decided before the type existed — #60's cascade, #19's role slicing, the stage-9 orphan check, and stage 5's own third exit criterion. The gap was old: notes.md names 'design component' three times in the traceability chain and #38's sixteen omitted it, so a chain four decisions rest on had a missing link that nothing noticed until a stage was actually run. The produces[] reframing preserves the useful draft table while correcting its overstatement: two stage runs found declared types legitimately unused, and the honest reading is that the table describes a project type rather than a stage. The gate already computed the intersection, so this is wording catching up with behaviour rather than a change of behaviour.

### DEC-0009 — The v1 handoff export exists, and is produced by an explicit deterministic command

A v1 export exists. It is produced by an explicit deterministic command — `npm run handoff` — that reads planning-content and writes the frozen package under docs/plan/. Generation is NEVER a gate side effect and never a freeform agent task: the gate stays READ-ONLY and reports whether the package may be produced, and the command is what produces it. `CMP-0011` is the component that will implement it, and it satisfies REQ-0010 and REQ-0011.

**Why:** Separating the gate from the generator keeps two different failure modes apart. A gate that generated as a side effect could not be run to ASK a question — every check would mutate the repository, and #46's 'warn continuously' becomes 'rewrite continuously'. A freeform agent task fails the other way: the package would differ between runs, and a handoff that cannot be reproduced cannot be reviewed. An explicit command is reproducible, inspectable in a diff, and callable by a human or by CI without either of them approving anything. The folder in the repo IS the delivery (docs/plan/README.md), so there is no service to keep alive and the artifact of the handoff is a commit.

### DEC-0010 — The authoring skeleton is not the delivery surface; v1 delivers JSON and generated Markdown

For v1: canonical JSON serves automated consumers, and generated Markdown — including a top-level PLAN.md — serves human readers. The authoring skeleton (app/server.mjs) is a tool for working ON the plan and is NOT the delivery surface. An interactive site for the recipient requires separate demonstrated demand; it is not assumed by REQ-0011.

**Why:** REQ-0011 requires that both a human reader and an automated consumer can recover every required item. It does not require that they use the same surface, and reading it as 'therefore build an app for the recipient' inflates a requirement about legibility into a commitment about product. Generated Markdown satisfies the human half with no infrastructure — it renders in any editor, in the repository host, and in a diff — while the JSON the artifacts already are satisfies the agent half without a second serialisation to keep in sync. Keeping the authoring surface out of the delivery also preserves the property that the handoff is a frozen package: a live app shows current state, and a handoff must show the state that was approved.

### DEC-0011 — `runbook` is not retained for v1: the real handoff needs none of its candidate fields

`runbook` is NOT built and is deactivated on this project. The three fields that would have justified it — whole-run preconditions, abort criteria, and cross-step rollback — are not needed by the handoff v1 actually produces. Membership in #38's catalogue is a separate act under #107's three-authority rule and is NOT performed here; the type remains in the catalogue, unimplemented and unactivated, with the condition that would reopen it recorded. `runbook-step.partOf` keeps its declared unresolvable target (#75), which is the mechanism that lets the edge exist while the aggregate does not.

**Why:** Applied to the real handoff rather than to the idea of a runbook. (1) WHOLE-RUN PRECONDITIONS: this project's package is generated by `npm run handoff` and read; it has no preconditions to satisfy before executing anything, and where a real deployment would have them, an ordered first step expresses them without an aggregate. (2) ABORT CRITERIA: `runbook-step` already carries `remediation`, `destructive` and `dependsOn`, and #58's floor is per-step by decision — an abort spanning steps is meaningful only for a multi-step destructive procedure, and v1's handoff contains one step that is `partOf` nothing. (3) CROSS-STEP ROLLBACK: the same, and it is the strongest of the three — a rollback spanning steps genuinely has nowhere to live. But nothing in this handoff needs one, and #106 is explicit that a type is built when work demands it, not when a plausible use can be imagined. Membership is derived by reversing `partOf` (#84), and ordering is `ordinal` plus `dependsOn`, so an aggregate is a PROJECTION at handoff rather than stored state.

### DEC-0012 — Planned, implemented and accepted are separate facts with existing owners

No status axis is added to `component`. Planned, implemented and accepted are three separate facts and each already has an owner: `implementedBy` says whether code exists, an acceptance criterion's `outcome` says whether it works, and the stage attestation says whether the plan claims it is finished. A `state: planned | built` field would answer none of them well and would be stored derived state, which can lie the moment the code it describes is deleted.

**Why:** QST-0015 was raised when CMP-0011 took the orphan count to zero while nothing was built, and running stage 7 dissolved it rather than answering it: the single question was three questions. The decisive objection to a field is #96's, applied in a new place - `built` is DERIVABLE from implementedBy plus criteria outcomes, and a derived value that gets stored is a value that can disagree with reality without anything noticing. The hazard the question named is real and is answered by making the derivation available rather than by adding a flag: ACC-0010 was written BEFORE the code and sat at `not-evaluated`, which is exactly the state a planned-versus-built boolean was wanted for.

### DEC-0013 — A stage criterion demanding a type is circular demand, not an independent consumer

`risk` stays INACTIVE on this project and REMAINS in the catalogue. The general rule: when the only consumer that would traverse a type is the stage criterion that declares the type, that is circular demand and does not satisfy #41. A type is retained in the catalogue - not removed - until a project produces authentic downstream use.

**Why:** Stage 6 was run and produced exactly one consumer for `risk`: its own `high-severity-risks-mitigated` criterion. Compare `component`, whose four consumers were all decided before the type was proposed, and `acceptance-criterion` and `task`, which had the same property. The distinction is not how MANY consumers but whether any exists independently of the demand: a criterion saying 'every risk must be mitigated' cannot be evidence that risks need to be artifacts, because it presupposes it. Keeping the type in the catalogue rather than deleting it preserves the possibility that a deployment-shaped project has real downstream use, which this planning-system project does not.

### DEC-0014 — Stage 9's `critical` is DEC-0002's definition, not a new category

An unanswered question is CRITICAL for stage 9's `no-unresolved-critical-questions` when it blocks active handoff content or makes a handoff criterion unevaluable. This reuses DEC-0002's shape rather than inventing a second subjective scale, and the stage definition's criterion text is amended to say so.

**Why:** Stage 9's run found `critical` undefined - the second instance of the defect stage 4 hit with `blocking`. Inventing a fresh category would double the vocabulary and leave two words that both mean 'important' with different unstated tests. DEC-0002 already separates a decision whose absence would make a commitment possibly wrong from work that is simply not done, and the handoff needs exactly that distinction scoped to what it publishes: a question is critical if the package would carry something wrong without its answer, or if a criterion cannot be judged.

### DEC-0015 — Stage attestations approve the PACKAGE; reviewStatus approves the ARTIFACT, and executable content needs both

The two are different approvals of different things and neither substitutes for the other. Stage attestations approve the PACKAGE: a human looked at each exit criterion and said satisfied, not-satisfied or n/a (#93). `reviewStatus` approves the ARTIFACT: someone reviewed that particular statement. For v1: (a) the package's MANIFEST and README state explicitly that the package is approved at STAGE level and carry the per-artifact review counts, so a machine consumer can see the basis rather than infer it; (b) artifact classes that become EXECUTABLE handoff content — `runbook-step` and `task` — must be `approved` or `amended` before they may be published, because those are the artifacts a recipient acts on; (c) every other class ships at whatever review status it holds, visible in the data.

**Why:** The first real package exported 98 artifacts as `draft` while describing itself as approved state, and the ambiguity was visible to machine consumers - which is the strongest kind of defect report, because the package said two things at once. Collapsing the two approvals either way would lose something real: making attestations sufficient would let a recipient act on an instruction nobody reviewed, and requiring per-artifact approval for everything would demand review of exploratory questions and superseded assertions that nobody needs to sign. The line is drawn at EXECUTABILITY because that is where the cost of being wrong changes: a draft question is a note, and a draft runbook step is an instruction someone follows. #57 and #59 already draw the same line for confidence and acknowledgement.

### DEC-0016 — The package snapshot is a normalized whole-package hash

Every file is rendered with a fixed placeholder where the snapshot goes; the entire tree - including MANIFEST.json and README.md - is hashed over canonical path names plus bytes; the placeholders are then replaced with the resulting hash. Verification performs the same normalization before recomputing. `toolVersion` is provenance metadata and carries no part of package identity. A separate generator fingerprint is optional and is not required.

**Why:** The previous scheme hashed every file EXCEPT the two that embed the snapshot, which excluded material content to avoid a self-reference. Republishing exposed the cost: adding the `approval` block to MANIFEST.json produced a materially different package under the same identity, b218b4a525c6176b. Normalizing removes the self-reference without excluding anything - a renderer change that alters any output now changes the snapshot, and one producing identical output correctly retains it, which is exactly the property that makes a package reviewable in a diff. It also relieves `toolVersion` of a job it was silently failing at: this repo's version is 0.0.0 and has never been bumped.

## Claims

### AST-0001 — chokidar sees events fs.watch misses on Windows

On Windows, chokidar reports every file creation in a watched tree where Node's fs.watch({recursive:true}) does not.

**supported · environment-matched** (derived)

Rests on: EVD-0001 (support)

### AST-0002 — The lockfile serialises concurrent creates

Concurrent createArtifact calls in separate processes never receive the same allocated ID.

**supported · environment-matched** (derived)

Rests on: EVD-0002 (support)

### AST-0003 — The concurrency test passes on every completed full-suite run

On Windows 11 with Node v24.18.0, with lock acquisition retrying EEXIST only, running `node --test` over the full suite, the separate-process concurrency test passes on every completed run. One failing completed run falsifies this.

**refuted · experimentally-validated** (derived)

Rests on: EVD-0003 (refute)

### AST-0004 — Windows surfaces exclusive-create contention as EPERM, not only EEXIST

On Windows, openSync(lockPath,'wx') can return EPERM while another process holds or is releasing the lock, so a retry loop keyed only on EEXIST treats transient contention as a fatal error.

**supported · environment-matched** (derived)

Rests on: EVD-0004 (support)

### AST-0005 — With contention codes retried, concurrent creates complete without error

On Windows 11 / Node v24.18.0, with lock acquisition retrying EEXIST, EPERM, EBUSY and EACCES, the separate-process concurrency test completes without error across the declared 80-run matrix.

**supported · environment-matched** (derived)

Rests on: EVD-0005 (support)

### AST-0006 — Without Cache Components, `next dev` renders every page on demand

With cacheComponents disabled (the default), Next.js in development renders pages on demand and never caches them, so a Server Component re-reads artifact files on each request.

**supported · environment-matched** (derived)

Rests on: EVD-0007 (support), EVD-0010 (support), EVD-0011 (support)

### AST-0008 — An external write alone produces no request, re-render or browser update

Under Next.js 16.3.1 in `next dev` on Windows 11 / Node v24.18.0, writing an artifact file from a process outside the application causes no new server request, no server re-render, and no browser update within 10 seconds, in either cacheComponents mode.

**supported · experimentally-validated** (derived)

Rests on: EVD-0008 (support), EVD-0009 (support)

### AST-0009 — With Cache Components, an AWAITED fs read is treated as uncached data

With cacheComponents enabled, a Server Component that reads an artifact with `await readFile()` is treated as uncached data — it must sit within `use cache` or behind a Suspense boundary, and a fresh request after an external write returns the new value.

**supported · environment-matched** (derived)

Rests on: EVD-0006 (support), EVD-0013 (support)

### AST-0010 — With Cache Components in a PRODUCTION build, a synchronous fs read freezes into the static shell

With cacheComponents enabled, under `next build` followed by `next start`, a Server Component reading an artifact with fs.readFileSync produces output baked into the static shell, so a later external write does not change what a fresh request returns.

**supported · source-supported** (derived)

Rests on: EVD-0006 (support)

### AST-0011 — In `next dev` with Cache Components, a synchronous fs read does NOT freeze

With cacheComponents enabled under `next dev`, a Server Component reading an artifact with fs.readFileSync re-reads the file on a fresh request, so an external write is reflected.

**supported · environment-matched** (derived)

Rests on: EVD-0012 (support)

### AST-0012 — A Next.js route handler can perform the lock-protected write-back correctly

Under Next.js 16.3.1 in `next dev` on Windows 11 / Node v24.18.0, a route handler calling writeReviewStatus writes only reviewStatus, refuses any other lifecycle value, releases the lock, leaves no temp file, and waits rather than proceeding while an external process holds the lock.

**supported · environment-matched** (derived)

Rests on: EVD-0014 (support), EVD-0015 (support)

### AST-0013 — The research capability probe is live and costs no search credit

On the PM's Windows host on 2026-08-22, `research_capability` returned available:true after a live GET /usage against api.tavily.com, reporting 1500 of 1500 credits remaining and 0 used. The zero-used figure is what shows the probe did not perform a search.

**supported · environment-matched** (derived)

Rests on: EVD-0017 (support)

### AST-0014 — Tavily's published docs state the free plan provides 1,000 credits per month

Tavily's own documentation at docs.tavily.com states that the free plan provides 1,000 API credits per month.

**supported · source-supported** (derived)

Rests on: EVD-0016 (support)

## Open questions

### QST-0002 — Does `research-finding` own anything irreducible, or is it a projection?

Is there state a research-finding artifact would hold that is not already held by evidence(kind: source), assertion, or question — and that something downstream must traverse (#41)?

## Tasks

### TSK-0001 — Generate role slices from the task graph

Extend the handoff renderer to emit one slice per role, as a query over tasks grouped by `role`, pulling each task's traced requirements and acceptance criteria with it. No slice is authored or maintained.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0011 · fulfils: REQ-0010, REQ-0011*

### TSK-0002 — Derive stage 6's scope from graph use rather than a flag

Replace `load-bearing-assertions-at-rung`'s reliance on the optional `loadBearing` flag with a scope derived from the graph — at minimum, every assertion referenced by an active runbook step's `restsOn`.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0002 · fulfils: REQ-0009*

## Retired and superseded

⚠️ **Not part of the current plan.** Listed because removing them silently would make this
rendering disagree with the machine-readable data, which is the parity REQ-0011 requires.

- **AST-0007** (assertion, superseded) — With Cache Components, a SYNCHRONOUS fs read freezes into the static shell
- **RBS-0001** (runbook-step, retired) — Run specialists in parallel
- **REQ-0015** (requirement, retired) — The system runs locally for a single operator
