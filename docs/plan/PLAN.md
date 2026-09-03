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

### REQ-0016 — The application displays the project's current stage

The application shows which stage the project is in, derived from the stage definitions and the recorded attestations rather than from a stored status value.

*Priority: must*

### REQ-0017 — The application renders a stage document authored in MDX

The application renders the MDX stage document for a selected stage, and a document referencing a component outside the permitted set does not execute arbitrary code.

*Priority: must*

### REQ-0018 — The application reflects external content changes without a manual reload

When a file under the content root is changed by something other than the application, the application's view updates without the operator reloading the page, and a dropped update stream is visibly distinguishable from an idle one.

*Priority: must*

### REQ-0019 — The application performs review-status updates through the existing typed write path

A review-status change made in the application is written by the existing typed operation — lock, fresh read inside the lock, atomic write — and the application contains no other write path into content.

*Priority: must*

### REQ-0020 — The application is installable and runnable locally from a documented command

An operator can install and start the application on a clean machine from documented commands, and the supported deployment mode is stated rather than implied.

*Priority: must*

### REQ-0021 — Planning-content reads are confined to the approved abstraction, and the confinement is checked statically

Every read of planning content in the application goes through a single reading abstraction that applies the DEC-0019 contract. A direct filesystem read of the content root anywhere else in the application fails a check that does not depend on running the application or observing what it serves, and the same check verifies that each read site is enclosed by a `<Suspense>` boundary. Acceptance for REQ-0016, REQ-0017 and REQ-0018 may not rest on freshness behaviour alone.

*Priority: must*

### REQ-0022 — One documented command carries a clean project to a running planning conversation

From a machine that has Git and the supported Node version and nothing else of Kiln's, one documented command must initialise the planning workspace, install the pinned agent runtime, obtain every decision it needs from the operator, and end with the planning agent conversing about this project — or refuse, naming the phase that stopped and an exact command that resumes it. Starting the browser application alone does not satisfy this requirement.

*Priority: must*

### REQ-0023 — Existing configuration is inspected, and then used, only under separately granted permission

The system must not read the operator's provider authentication store, custom-model registry, or the presence of credential environment variables before the operator has permitted that inspection. Having detected a usable configuration must never by itself authorise adopting or using it. Permission to inspect, confirmation of an exact provider and model, and permission to validate and use an optional external service are three decisions, each granted separately and each recorded where a different operator on a different machine does not inherit it.

*Priority: must*

### REQ-0024 — Credential material never enters project files, logs, process arguments, or planning content

No committed project file, emitted log line, error message, generated artifact, test fixture, or constructed process argument may contain a credential value or a value derived from one. A credential reaches a subprocess only through an audited contract that names, for one selected provider, the exact environment-variable names required; a provider with no such recorded mapping is refused rather than granted a wider inheritance of the operator's environment.

*Priority: must*

### REQ-0025 — Agent work runs on an explicitly selected and proven model, or it does not run

The provider and exact model used for planning work must be chosen by the operator from what discovery reports, recorded as reproducible non-secret project configuration naming exact identifiers rather than a mutable alias, and proven able to perform the tool calls the system depends on before the system describes the agent as ready. When the recorded selection cannot be resolved or authenticated, the system must refuse to begin or resume planning work rather than substituting another model, another provider, or its own memory.

*Priority: must*

### REQ-0026 — A delegated result is used only when the child that produced it is proven to have had its tools

Before any part of a specialist's substantive answer is read or acted on, the system must observe that the child ran with the capability signature and tool set its role contract requires. A child that exited cleanly, emitted a well-formed transcript, and did not have those tools must fail the delegation loudly; its prose must not be accepted as the answer to the delegated task.

*Priority: must*

### REQ-0027 — Runtime state survives a tool update and never enters version control

Session transcripts, launch state, consent records, compatibility results and setup journals must be written where updating the tool clone cannot destroy them and where ordinary version control does not track them, while reproducible non-secret project configuration remains committed and reviewable. The system must not write runtime state into a location before the ignore coverage protecting that location is in place.

*Priority: must*

### REQ-0028 — A readiness claim names what answered

Before reporting a component ready, the system must confirm the identity of whatever responded: that the HTTP service answering the port is the process this invocation started and is serving this project, that the loaded package is the one it installed, and that the model answering is the one recorded. A response that merely arrives, from an unidentified source, is not readiness and must not be reported as such.

*Priority: must*

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
*Implemented by: lib/layout.mjs, lib/content-root.mjs, lib/atomic-write.mjs, lib/lock.mjs, lib/id-allocator.mjs, test/content-root.test.mjs*

### CMP-0004 — Schema layer

Owns the artifact schemas, their composition through one envelope, and the effective-schema resolution every consumer reads materiality from.

*Satisfies: REQ-0007, REQ-0008*
*Implemented by: schemas/, lib/schema-resolver.mjs, lib/validate.mjs, lib/template.mjs*

### CMP-0005 — Typed tools

The only way an artifact is created or mutated (#88), including the guards that make each transition refusable.

*Satisfies: REQ-0013, REQ-0014*
*Implemented by: lib/tools/, test/link-trace.test.mjs, test/evidence-tools.test.mjs*

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

### CMP-0012 — Planning-content reader

Be the single path by which the application reads planning content from disk, applying the DEC-0019 contract on every read: await `connection()` before the filesystem access, inside a `<Suspense>` boundary whose fallback is a real loading state for that content. Everything the shell knows about the plan enters through here.

*Satisfies: REQ-0016, REQ-0017, REQ-0018*
*Implemented by: app/_read/planning.js, test/reader-discipline.test.mjs*

### CMP-0013 — Restricted MDX compiler

Compile a stage document to a renderable component at request time using `@mdx-js/mdx`, running the rejection plugin that fails the compile with a file path and a line:column position on any ESM import or export, JavaScript expression, JSX attribute expression, JSX spread attribute, or JSX element outside the permitted component set. Own the pinned compiler and plugin chain.

*Satisfies: REQ-0017*
*Implemented by: app/_mdx/compile.js, app/_mdx/reject-js.js, app/_mdx/components.js, test/mdx-rejection.test.mjs*

### CMP-0014 — Server adapter layer

Be the only door from application code into `lib/`. Each module begins with `import 'server-only'`, re-exports by explicit name or wrapper rather than `export *`, and exposes only the capabilities the shell needs; process-spawning, locking and stateful modules pass through individual review before they are exposed at all.

*Satisfies: REQ-0019*
*Implemented by: app/server/content.js, app/server/stages.js, app/server/README.md, test/server-adapters.test.mjs*

### CMP-0015 — Project view

Render `/`: the project's current stage derived from stage definitions and recorded attestations, navigation across all nine stages with each one's gate state, artifact counts, and lint findings. Report only counts it actually rendered.

*Satisfies: REQ-0016*
*Implemented by: app/page.js, app/stages-panel.js, app/diagnostics-panel.js, test/stage-derivation.test.mjs, test/diagnostics.test.mjs*

### CMP-0016 — Stage view

Render `/stage/[stageId]`: the stage's document through the restricted MDX compiler, its exit criteria with their recorded attestations, and the entry points for review actions. Hold no correctness-critical state in the client.

*Satisfies: REQ-0017, REQ-0019*
*Implemented by: app/stage/[stageId]/page.js, app/stage/[stageId]/criteria-panel.js, app/stage/[stageId]/document-panel.js, app/stage/[stageId]/review-panel.js*

### CMP-0017 — Change stream

Keep every open view current: watch the content root, emit a named heartbeat event carrying data at a fixed interval, deliver change notifications as hints, and run the client watchdog that renders a visibly disconnected state when a heartbeat does not arrive. On reconnection, reload.

*Satisfies: REQ-0018*
*Implemented by: lib/change-stream.mjs, app/server/change-stream.js, app/events/route.js, app/_stream/logic.js, app/_stream/watchdog.js, app/layout.js, bin/browser-check.mjs, test/change-stream.test.mjs, test/stream-watchdog.test.mjs*

### CMP-0018 — Review action

Perform review-status changes from the application through the existing typed write path — lock, fresh read inside the lock, atomic write — reusing `lib/tools/review-status.mjs` rather than reimplementing it, and reaching it through the server adapter layer.

*Satisfies: REQ-0019*
*Implemented by: app/server/review.js, app/_write/review-logic.js, app/_write/review-action.js, app/stage/[stageId]/review-panel.js, test/review-write.test.mjs*

### CMP-0019 — Import-boundary check

Statically prove, without executing the application, that every planning-content read goes through the reader inside a `<Suspense>` boundary and that no module outside `app/server/` imports from `lib/`. Detect bypass paths rather than only direct violations.

*Satisfies: REQ-0021*
*Implemented by: lib/shell-boundary.mjs, bin/lint-shell.mjs, test/shell-boundary.test.mjs, test/shell-read-boundary.test.mjs, test/fixtures/boundary/, test/fixtures/readboundary/*

### CMP-0020 — Launcher

Install and run the shell from one documented command: build the application and start it in production mode, owning the `next start` process as a child, forwarding shutdown to it, waiting for it to exit, and leaving nothing behind — no process on the port, no temporary directory it created. The file watcher is an in-process resource of the child and is released by its teardown.

*Satisfies: REQ-0020*
*Implemented by: bin/start-shell.mjs, lib/run-identity.mjs, docs/running-the-shell.md, package.json, next.config.mjs, test/launcher.test.mjs*

### CMP-0021 — Pinned Pi runtime

Be the only route by which any Pi process is started. Resolve the exact pinned CLI from the tool's own node_modules, report its version, refuse a version that does not match the pin, and hand every caller — setup, the user-facing session, and every specialist child — the same executable invoked through the current Node binary with shell interpolation disabled. Discovering Pi on PATH is outside this component and outside the product.

*Satisfies: REQ-0022, REQ-0028*
*Not yet implemented.*

### CMP-0022 — Setup transaction

Own one project-wide lock for the whole of setup, and make every lasting write happen under a plan rather than in sequence: canonicalise and print each target before mutating, schema-validate every file it may read or merge, probe same-directory temporary-file creation and atomic rename in each parent it will write to, record the identity of each existing file, re-compare that identity immediately before each merge, and maintain a non-secret journal that names the last completed phase so an interruption resumes rather than restarts.

*Satisfies: REQ-0027, REQ-0022*
*Implemented by: lib/setup-transaction.mjs, lib/lock.mjs, test/setup-transaction.test.mjs, test/initialize-project.test.mjs*

### CMP-0023 — Project ignore owner

Be the single owner of every Kiln edit to the consumer's `.gitignore`: plan the change without writing, append rather than rewrite, take the line ending from the file, record what it did, migrate an exact unmodified legacy block to the extended block under the same lock and atomic-write discipline, and never restore a block the operator deliberately removed or edited.

*Satisfies: REQ-0027*
*Not yet implemented.*

### CMP-0024 — Pi settings merge

Merge only Kiln's owned fields into the project's `.pi/settings.json` — the local package entry, the skill-override path, the selected default provider, model and thinking level, and the project-local session directory when that mode is chosen — preserving every unrelated key and package entry, refusing a malformed or unknown-schema-version file rather than replacing it, and changing no bytes when the desired state is already present.

*Satisfies: REQ-0024, REQ-0025*
*Not yet implemented.*

### CMP-0025 — Local-state policy

Decide and enforce where session transcripts, consent records, compatibility results and setup journals live: by default under the outer project's ignored `.pi/sessions/` and `.pi/runtime/`, or, when explicitly selected, under an external per-user root derived from the committed non-secret project ID. Refuse to write any runtime data before the chosen location's protection is in place, and never commit an absolute user path in order to reach it.

*Satisfies: REQ-0027, REQ-0023*
*Implemented by: schemas/runtime/, lib/runtime-records.mjs, test/runtime-records.test.mjs*

### CMP-0026 — Project trust integration

Obtain, verify and report the operator's trust decision for this project's Pi resources through Pi's own supported mechanism, display the canonical project path the decision applies to, treat a denial as a first-class outcome that stops agent launch without touching the planning scaffold, and refuse a non-interactive run that has no pre-existing decision rather than defaulting one.

*Satisfies: REQ-0023, REQ-0026*
*Not yet implemented.*

### CMP-0027 — Connection inspection and consent

Ask before looking, and record what was granted. Obtain explicit permission before reading Pi's user authentication store, its custom-model registry, or the presence of any credential environment variable; then report sanitised availability only — provider display names, model identifiers, and present-or-absent for the research credential — contacting no external service. Persist the operator's grant where a clone does not carry it to another machine, and reopen the prompt when the provider or research choice changes.

*Satisfies: REQ-0023, REQ-0024*
*Not yet implemented.*

### CMP-0028 — Model binding

Turn discovery into a recorded decision and hold it: present available providers and exact model identifiers, require confirmation even when exactly one is available, persist the exact non-alias identifiers as project configuration, state plainly that subsequent work on this model may be billed, and at every later launch resolve that recorded selection and refuse the run if it is unavailable rather than falling back.

*Satisfies: REQ-0025, REQ-0023*
*Not yet implemented.*

### CMP-0029 — Provider credential contracts

Be the single audited statement of which environment-variable NAMES each supported provider needs on the model plane, holding no values; separate those from tool-plane names that belong to one role; construct each child's environment from the measured base runtime variables, the selected provider's model-plane names and that role's tool-plane names, adding nothing else; and classify a provider with no safe known mapping as unsupported rather than granting it a wider inheritance.

*Satisfies: REQ-0024, REQ-0026*
*Not yet implemented.*

### CMP-0030 — Live model and tool canary

Prove, with one separately authorised request, that the selected provider and model actually answer and actually emit the shape of tool call Kiln depends on: expose a single read-only setup-only tool, require the model to call it with a random challenge against the declared schema, send no planning content, permit no mutation, cap the token budget, and record success only against the exact provider, model, thinking level, runtime version, package capability signature and non-secret endpoint identity that produced it.

*Satisfies: REQ-0025, REQ-0023, REQ-0028*
*Not yet implemented.*

### CMP-0031 — Kiln Pi package

Be the installable unit Pi loads for this project: a declared package manifest naming its extensions, skills and prompts; a registration entry point; and a machine-readable capability signature that any consumer — the supervisor, the canary, a delegation verifier — can compare against what it expected to be loaded.

*Satisfies: REQ-0022, REQ-0026, REQ-0028*
*Not yet implemented.*

### CMP-0032 — Pi tool registration

Expose the existing typed libraries to the agent as validated Pi tools and nothing more: project status and lint reads, artifact creation and mutation through the existing registries, project-type activation, stage attestation reads and writes, the research and validation capability adapters, and delegation. Own the tool schemas and result rendering; leave every business rule in `lib/`. Launch the session with Pi's built-in filesystem and shell mutation tools disabled.

*Satisfies: REQ-0022, REQ-0024*
*Not yet implemented.*

### CMP-0033 — Stage skill generation and overrides

Generate one packaged skill per canonical stage definition so that stage purpose, outputs and exit criteria are never hand-maintained twice, fail a check when the packaged skills are stale relative to `stages/`, and register the consumer's own override directory after the packaged set so an override with the same identity wins without editing the tool clone.

*Satisfies: REQ-0022*
*Not yet implemented.*

### CMP-0034 — User-facing orchestrator

Be the single persistent planning session: resolve the canonical sibling content root and refuse to operate on the tool's own planning content, derive the current stage from definitions and attestations rather than storing a duplicate status, load the matching stage skill, ask one question at a time chosen by information value, keep the operator's wording separate from its own interpretation, mutate only through registered typed tools, show material changes before making them, and resume from files and attestations when the transcript is gone.

*Satisfies: REQ-0022*
*Not yet implemented.*

### CMP-0035 — Specialist roster

Declare the research, planning and validation roles as data: stable name and description, an explicit tool allowlist, input contract, responsibilities, forbidden actions, output schema, exit criteria and escalation conditions. Derive write boundaries and required tool signatures from the existing specialist contract rather than restating them, and treat a role definition with no declared tool list as a lint error.

*Satisfies: REQ-0026*
*Not yet implemented.*

### CMP-0036 — Delegation runtime

Run a specialist as an isolated Pi child and decide whether its answer may be used: build a task-scoped context rather than forwarding the conversation, bind the role prompt and the task through a private file with restrictive permissions and closed stdin, pass the orchestrator's exact provider, model and thinking level, pass the intersection of the role's allowlist and the measured host registry, enforce a bounded timeout, delete temporary material on every exit path, and verify the child's capability signature before reading its substantive output.

*Satisfies: REQ-0026, REQ-0024, REQ-0025*
*Not yet implemented.*

### CMP-0037 — Combined runtime supervisor

Own the lifecycle of the two processes that make up a running Kiln: validate the project and settings, choose and prove a port, start the browser launcher with a private stdin pipe so it cannot consume the operator's typing, wait for identity-confirmed readiness, start Pi in the outer project root with the terminal inherited, begin or resume the recorded planning session, and on exit or signal stop both process trees within bounded grace periods and remove only what this invocation created.

*Satisfies: REQ-0022, REQ-0028*
*Not yet implemented.*

### CMP-0038 — Run-identity health endpoint

Answer the supervisor's readiness question with an identity rather than a status: the service name, a versioned health protocol, the ephemeral run identifier of this invocation, the non-secret stable project identifier, and the build version — and nothing else, in particular no absolute path, no credential, and no session or planning content.

*Satisfies: REQ-0028*
*Implemented by: lib/run-identity.mjs, app/health/kiln/route.js, app/server/identity.js, test/run-identity.test.mjs*

### CMP-0039 — Setup command

Compose the whole first run in one ordered, resumable, idempotent command over the existing primitives: resolve and print every path before mutating, validate the runtime, run the existing initializer under the shared transaction, establish state protection, install and register the package, obtain each consent in its own step, bind and prove the model, read back everything it wrote, and either launch the combined runtime or explain exactly what remains. Use a distinct exit code per refusal class and publish the mapping.

*Satisfies: REQ-0022, REQ-0023, REQ-0027*
*Not yet implemented.*

### CMP-0040 — Clean-consumer agent-delivery verification

Prove the documented journey from an empty directory on both supported platforms: initialise a repository with no commits, take a tracked-file-only copy of the tool as the clone, run the documented setup against a deterministic non-billable provider, drive a Stage 1 exchange, observe the intake document change through the browser's change stream, attempt an unauthorised stage advance and see it refused, shut down and prove nothing is left running, then rerun and prove resumption and idempotency.

*Satisfies: REQ-0022, REQ-0028*
*Not yet implemented.*

### CMP-0041 — Pi compatibility evidence suite

Establish, against the exact pinned runtime and on each supported platform, what Pi actually does where the agent-delivery design depends on it — local resolution from a consumer's own install and version match; trust grant, denial and revocation through the public API; saved API-key discovery and provider auth status; configuration-directory resolution under default and overridden settings; the literal package entry `pi install -l` writes and its canonical equivalence to the committed form; extension, skill and prompt loading; skill-override precedence; session relocation; task binding with closed stdin; the default and allowlisted tool sets; and provider-scoped environment authentication reaching a child — each with a negative control and redaction assertions, retained as tests in the normal suite so a later version bump must re-prove the contract rather than inherit it.

*Satisfies: REQ-0022, REQ-0024, REQ-0026, REQ-0027*
*Implemented by: tools/pi-compat/lib/consumer.mjs, tools/pi-compat/lib/spike.mjs, tools/pi-compat/lib/probe.mjs, tools/pi-compat/lib/redact.mjs, tools/pi-compat/fake-provider.mjs, tools/pi-compat/run-all.mjs, tools/pi-compat/posix-bootstrap.sh, tools/pi-compat/runs/windows.json, tools/pi-compat/runs/linux.json, test/pi-compat.test.mjs, .github/workflows/ci.yml*

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

### DEC-0017 — The Next.js shell reuses the substrate; the skeleton is not migrated

The Next.js/MDX application is built as a NEW shell that imports the existing lib/ modules — lint, derivation, locking and the typed operations — as the single implementation. `app/server.mjs` remains in place as the verified substrate reference until the Next.js slice reaches behavioural parity with it, and is not migrated, ported or edited to become the application.

**Why:** The skeleton exists to prove the risky surface — the watcher, the derivation and the status write-back — and it has a test suite asserting exactly those properties. Migrating it would spend that proof on a rendering framework it was deliberately built to avoid, and would leave nothing to compare the new shell against. Keeping it as a reference makes parity CHECKABLE rather than asserted: two callers of the same modules should agree, and a disagreement is a finding about the new shell.

### DEC-0018 — The application ships in production mode; `next dev` is a contributor workflow only

The application shell's supported configuration is `next build` followed by `next start`. `next dev` remains available to contributors working on the application and is not a shipped configuration: nothing a consumer runs, and nothing the project validates against, is the development server.

**Why:** AST-0015 is decisive on its own: `next dev` and `next build` produce different artifacts, so shipping the development server means shipping a configuration this project can NEVER validate as production — every validation would be measuring something other than what users receive. A shipped configuration should be validated in the mode users receive, and that principle does not depend on how well the development server behaves. AST-0017 establishes the option is actually available: a self-hosted Node.js deployment supports all Next.js features with no platform or adapter, so production mode is reachable for a local-first clonable tool. AST-0018 removed the project-specific objection — a concurrent `next dev` did not measurably interfere with the chokidar watcher — but that argument was never the reason to prefer production, only a reason someone might have preferred dev.

### DEC-0019 — Planning-content reads go through `connection()` inside a Suspense boundary

Every server-side read of planning content must await `connection()` from `next/server` before the filesystem read, and that read must sit inside a `<Suspense>` boundary whose fallback is a real loading state for the content being read. This is the artifact-reading contract for REQ-0016, REQ-0017 and REQ-0018. A boundary added only to satisfy the build — one wrapping the whole page, or one whose fallback renders nothing — does not satisfy it: the boundary exists so the static shell can ship while the fresh read streams, and a page-level wrapper makes the whole page the fallback and buys nothing.

**Why:** The deciding property is independence from the Cache Components setting, not freshness. EVD-0023 measured three mechanisms that serve fresh reads, and only this one does so in both caching models: `export const dynamic` does not exist when Cache Components is enabled, `connection()` without a boundary fails the build there, and `io()` behind a boundary is fresh only when the flag is on. AST-0019 established that the freeze itself is unconditional, so the contract that fixes it must be unconditional too. A freshness contract that depends on an unrelated configuration flag is a contract that breaks silently when someone changes the flag — the same failure shape as the build-time freeze it replaces, and harder to see. Choosing `connection()` also keeps this decision inside the freshness contract: the caching model stays undecided, which is where it belongs until the component boundary work reaches it.

### DEC-0020 — Stage documents are restricted MDX, compiled at request time; forbidden JavaScript is an error

Stage documents are authored in MDX and compiled AT REQUEST TIME with `@mdx-js/mdx` (`compile` then `run`). They are NOT routed as `@next/mdx` file-based pages: that path compiles the document into the build and cannot satisfy REQ-0018. Compilation runs a remark plugin that REJECTS, with a file path and a line:column position, every ESM import or export, every JavaScript expression, every JSX attribute expression, every JSX spread attribute, and every JSX element whose name is not in the permitted component set. Rejection is the user-visible contract: forbidden JavaScript fails the compile and is never silently removed. The permitted set is the component mapping, which is the only route by which a component can reach a document once imports are refused. The compiler and its plugin chain are PINNED, and changing the MDX version or adding any remark, rehype or recma plugin reopens security validation before the change may ship. Stripping may be retained beneath the rejection as defence in depth, but it may never be the observable behaviour.

**Why:** AST-0023 established that MDX supplies no allowlist and that its own security model is trusting the author; AST-0026 recorded what that cost someone else, as CVE-2026-0969. AST-0027 showed the ecosystem's answer was to remove the capability rather than filter it. The amendment that shapes this decision is that removal must be LOUD: silent stripping reproduces exactly the failure AST-0028 found in the publisher, where content is absent while the output still looks valid, and this project already refuses that trade in `checkJob` — a shell-string command is refused rather than sanitised, because sanitising means guessing what the author meant. A document is a plan someone will act on; a line that vanished is worse than a build that stopped. Rejection also happens to be the only version that can produce a diagnostic at all: `file.fail` carries the node's position, while a stripping plugin has nothing to report because by construction nothing is wrong afterwards.

### DEC-0021 — The shell reaches `lib/` only through an `app/server/*` adapter carrying `server-only`

Application code reaches the shared `lib/` modules exclusively through a thin adapter layer under `app/server/`. Every adapter module begins with `import 'server-only'`, before any other import. Adapters re-export by EXPLICIT NAMED EXPORT or wrap the underlying function; blanket `export *` is not permitted. An adapter exposes only the capabilities the shell actually needs, and any module that spawns a process, takes a lock, or holds module-level state requires individual review before it may be exposed at all. No application code outside `app/server/` may import from `lib/` directly. `lib/` itself carries no `server-only` marker, so it remains importable by the CLIs in `bin/` and by the test suite under plain Node. REQ-0021's static check enforces this boundary and detects bypass paths.

**Why:** AST-0032 measured that the import itself needs nothing: a Server Component reaches a sibling `lib/` module by plain relative path with no alias or bundler configuration, so #47's single implementation stays single for free. What needed deciding was the boundary. A `'use client'` file drags all of its imports into the client bundle (EVD-0046), and while that already fails the build, unguarded it fails as a Turbopack internal error with `location: undefined` and no filename — indistinguishable from a bundler bug. The `server-only` marker changes no runtime behaviour and prevents nothing that was not already prevented; it makes the failure LOCATABLE, which in a tool whose whole premise is legible refusals is the difference that matters. AST-0033 then forced the placement: `server-only` throws when imported outside the RSC compiler, and `lib/` is imported by every `bin/` command and the whole test suite, so the marker cannot live there. The adapter is the only location that guards the app without breaking the tool, and the marker was measured to propagate through a re-export.

### DEC-0022 — The shell's lifecycle contract: a launcher owns both processes, and stream health is a visible event

The application is started by a documented launcher that owns the `next start` process. The file watcher is an in-process resource of that process: the change-stream service creates it on the first subscription and closes it when its last subscriber leaves, and terminating the application process releases any watcher still open through process teardown. The launcher's obligation is to terminate its child and leave nothing behind — no process on the port, no temporary directory it created — verified by observation. The update stream emits a NAMED heartbeat event carrying data at a fixed interval, and the client runs a watchdog that renders a visibly disconnected state when a heartbeat fails to arrive within its window; comment-only keepalives are not sufficient because the client parser ignores them. A watcher failure must either emit a visible failure signal on the stream or close the stream — logging alone is not permitted, because a page whose watcher has died otherwise stays live-looking and stale. On reconnection the client reloads, treating reconnection itself as a change hint; no event buffer, event id or `Last-Event-ID` handling is required, because events are hints and never deltas. A malformed or unreadable artifact must be surfaced visibly and located, and no rendered count may include an artifact the page did not render.

**Why:** AST-0034 measured that the skeleton's idle stream and its dead stream are byte-identical and that a change during a disconnect gap is never recovered, which refutes REQ-0018's second clause by construction. AST-0036 then removed the obvious repair: a comment heartbeat is ignored by the client parser, so it fixes the bytes without fixing the visibility — the page stays falsely healthy while something is demonstrably happening on the wire. A named event with a client watchdog is the smallest mechanism the requirement can actually be met with. The reconnect-as-change-hint design survives unchanged and is the part that removes work rather than adding it: because #73 makes events hints rather than deltas, a client that reloads on reconnection is exactly caught up, so the buffering and resumption machinery that a delta stream would need is unnecessary. AST-0035 supplies the read-path half: a corrupt artifact currently vanishes while the header still counts it, which tells the operator the missing thing is present.

### DEC-0023 — The first slice is two views: a project view and a stage view

The application shell opens with exactly two views. `/` is the project view: the derived current stage, navigation across all nine stages with their gate state, artifact counts under the truthful-count rule, and lint findings surfaced rather than re-judged. `/stage/[stageId]` is the stage view: the working stage document rendered as restricted MDX, the stage's exit criteria with their recorded attestations, and review actions through the typed write path. Both views are URL-addressable and server-rendered. NO CORRECTNESS-CRITICAL STATE IS HELD ONLY IN THE CLIENT: transient interface state is permitted, but anything a user must not lose — filters, a selected section, unsaved work, navigational context — is URL-encoded or persisted. The artifact tracker and the assertion/evidence view are DEFERRED, not removed.

**Why:** This is a product decision and no source settles it; sequencing it fifth bought elimination rather than evidence. DEC-0022 makes every content change and every reconnection a full page reload, which is the sharpest constraint and the one that would have been discovered last — it decides what state a view may hold far more than any preference about views does. DEC-0019's blocked prefetching argues for fewer, denser views, an inference from an accepted cost rather than a measurement. DEC-0020's per-request compilation cost is explicitly unmeasured, which caps the design at one stage document per view. DEC-0021 makes read-only views cheap while the review-status write is the one locking capability the slice must get individually reviewed and exposed. Two views is what remains once those four have spoken, and it satisfies REQ-0016 through REQ-0019 without adding a surface the truthful-count rule would then have to cover.

### DEC-0024 — An unknown stage returns HTTP 200 with a truthful body — accepted for v1

When `/stage/[stageId]` is given an id matching no stage, the application responds 200 and renders a visible not-found state. It does not return 404. The body is required to be truthful; the status is not. This is revisited if an API, a crawler, or any automated client comes to depend on HTTP status semantics for this route.

**Why:** The status is committed before the answer is known. `notFound()` runs inside a `<Suspense>` child, because the read that would reveal the id to be unknown may only happen there: DEC-0019 confines planning-content reads to the reader behind a boundary, and REQ-0021 makes that confinement a statically checked rule. By the time the stage is known not to exist, the shell has streamed and the status line is gone. The two ways to recover a 404 both cost more than it is worth here — validating in the route entry means reading outside the boundary, which the check refuses by design; keeping a separate list of stage ids in the route means a second registry that can silently disagree with the definitions on disk, which is the stored-derived-state failure #96 exists to prevent. This is a local, human-facing application served over loopback to one operator, and an operator reads the page rather than the status line.

### DEC-0025 — Keep restricted runtime MDX; the measured cost is not the compiler

Keep restricted runtime MDX for stage documents. Do not adopt DEC-0020's plain-Markdown alternative: the measurement that was supposed to trigger it instead disproved its premise.

**Why:** The compiler is not the cost, and it is the security boundary. DEC-0020 recorded the per-request compile cost as explicitly unmeasured and pre-committed to a fallback in case it proved large. It has now been measured and it is small: 15-29 ms p95 across six valid runs against the largest stage document. The fallback was contingent on a premise the measurement refuted, so it does not fire. ⚠️ THE BUDGET WAS STILL MISSED, AND THAT IS NOT BEING WAVED AWAY. ACC-0020 stays `fail` and stays in the record; it is superseded by a criterion that measures the disputed cost rather than deleted for being inconvenient. The unexplained 234-359 ms is recorded as an open performance question, non-blocking, to be INSTRUMENTED before anything is optimised. ⚠️ THE OBSERVED 245-375 ms STAGE RESPONSE IS ACCEPTED FOR v1 WITH ITS ATTRIBUTION OPEN. That is a judgement about a local-first planning tool on a developer's own machine, not a claim that the number is good.

### DEC-0026 — Pin @earendil-works/pi-coding-agent 0.84.4 and raise the Node floor to 22.19.0

Kiln declares an exact dependency on @earendil-works/pi-coding-agent 0.84.4 — the version npm publishes as latest on 2026-09-02 — and raises engines.node from >=22 to >=22.19.0 to match what that release requires. Every Pi invocation resolves that dependency from the tool's own node_modules. Changing the pin is an intentional, tested dependency update that re-runs the compatibility suite; it is never a range that floats.

**Why:** The compatibility spike has to run against something, and it is cheaper to run it once against the version consumers will actually receive than to run it against 0.80.6 and inherit four minor versions of skew on the first release. The Node floor is not a preference: 0.84.4 declares engines.node >=22.19.0, and Kiln's >=22 would let a 22.0 install resolve a runtime that cannot start.

### DEC-0027 — Project trust is granted through a supported Pi mechanism, not by writing Pi's trust file

Kiln does not write Pi's user-scoped trust store directly. Interactive setup obtains the decision through Pi's own trust flow or a supported public API; non-interactive setup accepts a pre-existing decision or refuses. If the pinned version exposes no supported route to record a decision programmatically, the proposed `--trust approve` option is removed or deferred rather than implemented by writing the file. This withdraws the mechanism half of decision #67(a); the detection half, #67(b), is unaffected and still owed.

**Why:** Writing another tool's undocumented user-scoped security file is brittle — its shape is unversioned and may change under any release — and it crosses a boundary that belongs to the operator rather than to Kiln. The argument that carried #67(a) was that a recorded decision keeps the grant where the operator can read and delete it, which remains right; what changed is the judgement that Kiln should not be the one writing it.

### DEC-0028 — The project's provider and model selection is committed configuration, with no local-only mode

The selected provider, exact model identifier and thinking level are written to the project's `.pi/settings.json` and committed. There is no local-only override mode in which the selection is kept out of version control. What is never committed is anything host-specific or secret: credentials, the operator's consent to use this machine's connections, session transcripts, and compatibility records.

**Why:** The selection is the answer to which model produced this project's content, and that answer belongs with the content. A local-only mode was floated in an earlier draft of the proposal and specified nowhere — no flag, no storage location, no precedence rule — which is the shape of a feature that sounds accommodating and has never been designed. Removing it also keeps one rule instead of two about what a clone inherits: configuration yes, consent no.

### DEC-0029 — Runtime state defaults to the outer project's ignored .pi/, with an explicit external mode

Session transcripts live under `<project>/.pi/sessions/` and launch, consent, compatibility and transaction records under `<project>/.pi/runtime/`, both covered by Kiln's marked `.gitignore` block and neither written before that coverage exists. `.pi/settings.json` and `.pi/kiln.json` are deliberately not ignored: they are reproducible, non-secret project configuration and should be reviewable in a diff. An explicit external mode relocates the two ignored directories to a per-user root keyed by the committed project ID, and exists only if the pinned runtime supports it.

**Why:** Two locations are excluded for different reasons. Inside the tool clone is wrong because `git pull` on `.planning/` is the update channel and may destroy anything there. Tracked inside the outer project is wrong because transcripts and consent records are host-specific and sometimes sensitive. What is left is an ignored directory in the outer project, which is also where Pi already expects project-local runtime state to live.

### DEC-0030 — The compatibility spike is a hard gate on the rest of the agent-delivery implementation

No agent-delivery implementation beyond the planning correction and the spike itself begins until the spike has produced reviewable evidence, on Windows and on the supported POSIX platform, for each behaviour the design depends on — each with a negative control that would fail if the claimed behaviour were absent, and with redaction assertions over command output, logs, errors and generated state. A behaviour the pinned version does not exhibit forces a design revision that is recorded before code is written against it.

**Why:** Every module in the runtime foundation encodes an assumption about what Pi does: how trust is granted, where configuration resolves, what the package entry looks like, what a child inherits. Building four phases on assumptions and discovering one is wrong means unwinding work that was correct against a specification and wrong against reality. The spike costs days; the unwind costs weeks and produces code that half-works.

### DEC-0031 — Repair the typed link layer in two ordered steps: unlinkTrace first, then derive the guard

Both halves of QST-0032 are fixed, and the order is part of the decision. FIRST, `unlinkTrace` stops validating the target type when REMOVING a link: removal is how an invalid or stale link is repaired, so validating it is a guard that refuses exactly the operations it exists to permit. Removal keeps every other discipline — lock, fresh read inside it, atomic write — and gains a typed removal path for `answeredBy`, which `resolveQuestion` can only ever merge. SECOND, and only after that, `reviseArtifact`'s trace-field guard is derived from the schemas' `x-traceTarget` declarations instead of the hardcoded list of seventeen names, closing the bypass on `blocks`, `raisedBy`, `satisfies`, `evaluates`, `verifies`, `fulfils`, `acceptedBy`, `implementedBy` and `answeredBy`. This work is scheduled AHEAD of Phase 2's implementation work rather than behind the agent-delivery layer.

**Why:** The order is not a preference. Today one defect is the only escape hatch for the other: a link that `unlinkTrace` refuses to remove can still be repaired through `reviseArtifact`, precisely because the guard's hardcoded list omits the field. Deriving the guard first would close that hatch while the links it currently repairs remain unremovable by any typed path — and #88 forbids hand-editing — leaving the graph with damage the lint reports and nothing can fix. Fixing removal first makes the guard's completion safe. As for scheduling it ahead of Phase 2: the defect was hit three times during Phase 1 alone, each from a different direction — a mistyped link while authoring, a routine supersession leaving a stale `answeredBy`, and a retarget in which `implements` was guarded while `evaluates` was not covered at all. Phase 2 edits the graph far more than Phase 1 did, so the rate rises rather than falls, and each occurrence currently requires knowingly exploiting a bug to repair.

### DEC-0032 — OAuth is verified by a manual account-bound run, never by a fabricated credential

Kiln supports OAuth through Pi's public interactive `/login` flow. Verification is a MANUAL, account-bound compatibility check run outside CI, and fabricated OAuth records are not an acceptable substitute. The protocol: run with an isolated Pi configuration directory and a sanitized environment; complete `/login` against a real subscription; after it exits construct a FRESH `ModelRuntime` and `ModelRegistry` and prove the chosen built-in model appears through `getAvailable()` and passes `hasConfiguredAuth()`; then remove or revoke the stored credential as the control and require the model to become unavailable. Retain only sanitized single-instance evidence — no tokens, headers, credential-derived values, usernames or home paths. Until that run passes, documentation may describe OAuth as a supported Pi route but must not call it verified, and no acceptance criterion may be written as though it were.

**Why:** A fabricated OAuth record proves that a JSON shape written into `auth.json` is read back — an internal storage detail — and says nothing about whether a real subscription authenticates, whether the token refreshes, or whether the provider accepts the request. It would be a green check over the thing that actually matters, which is the failure mode this whole cycle exists to prevent. The API-key path was provable with a fabricated credential precisely because a stored API key IS the whole mechanism; an OAuth token is one artefact of a live flow. Making the check manual and account-bound is the honest cost: it cannot run in CI, so it is single-instance evidence recorded once and labelled as such — the treatment section 15.3 already gives live paid-provider tests. The revocation control is what makes the positive result mean anything. Without it, a model that was already available for some unrelated reason — an inherited environment variable, a stale entry — would read as a successful login.

### DEC-0033 — The five runtime records are Ajv-validated contracts, and the canary key is eight determinants

Kiln's five persisted runtime records are schema-validated through the existing Ajv layer, in `schemas/runtime/` with an `x-runtimeRecord` discriminator and per-record versions. The cached canary result is keyed on exactly eight determinants, nested in a `key` object so comparison is one deep equality: provider, model, thinkingLevel, piVersion, apiType, endpointIdentity (with its source), effectiveRequestProfile, and preflightContractDigest. THE REQUEST PROFILE IS BOUNDED BY CLASSIFICATION, NOT BY HASHING: scalar compat fields and the safely typed structures are persisted by value; the unbounded inputs — `chatTemplateKwargs`, `chatTemplateArgs`, non-empty `samplingParams` and non-authentication headers — are recorded only as CATEGORY NAMES and require an explicitly supplied, non-secret declared identity, without which no result is cached at all. That identity is never derived from the values it stands for. Known authentication headers are credential transport: excluded entirely, and not determinants. The Kiln capability signature remains a zero-cost launch check.

**Why:** These five are Kiln-owned contracts: Kiln invents, writes, versions and reads them, so a shape nobody validates is a comment, and hand-parsing them would stand up a second informal schema implementation beside the real one. `.pi/settings.json` is deliberately NOT the precedent — Pi owns that file, an operator may hand-edit it, and Kiln merges four keys into it defensively. The key set contains only inputs capable of changing the proven model and tool behaviour, because it decides when a BILLABLE check re-runs: too wide and the operator is charged for nothing, too narrow and a proof is reused on a path nobody tested.

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

**supported · experimentally-validated** (derived)

Rests on: EVD-0006 (support), EVD-0022 (support)

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

### AST-0015 — Development and production are different builds, with different output locations

In Next.js 16.3.2, `next dev` and `next build` produce different builds: development output goes to `.next/dev` and production output to `.next`, and the two can run concurrently without conflicting.

**supported · source-supported** (derived)

Rests on: EVD-0018 (support)

### AST-0016 — Production mode requires a prior build step

In Next.js 16.3.2, `next start` starts the application in production mode and requires the application to have been compiled with `next build` beforehand.

**supported · source-supported** (derived)

Rests on: EVD-0019 (support)

### AST-0017 — A self-hosted Node.js deployment supports all Next.js features

In Next.js 16.3.2, deploying as a Node.js server is a supported option and Node.js deployments support all Next.js features, without requiring a hosting platform or adapter.

**supported · source-supported** (derived)

Rests on: EVD-0020 (support)

### AST-0018 — A concurrent `next dev` does not measurably interfere with a chokidar watcher on the same tree

On Windows with Next.js 16.3.2 and chokidar 5, a chokidar watcher observed all 20 externally-created files in a directory inside the Next.js project root while `next dev` was serving on loopback, at a detection latency indistinguishable from the same measurement taken with no dev server running; and `next dev` did not recompile in response to those writes.

**supported · experimentally-validated** (derived)

Rests on: EVD-0021 (support)

### AST-0019 — The production-build freeze is NOT conditional on Cache Components

Under `next build` + `next start` with Next.js 16.3.2, a Server Component reading an artifact with fs.readFileSync is prerendered as a static route and serves its build-time value regardless of whether cacheComponents is enabled or disabled; a later external write does not change what a fresh request returns in either configuration.

**supported · environment-matched** (derived)

Rests on: EVD-0022 (support)

### AST-0020 — `connection()` behind a Suspense boundary is the only measured mechanism fresh in both caching models

Under `next build` + `next start` with Next.js 16.3.2, a Server Component that awaits `connection()` inside a Suspense boundary before reading an artifact serves the current file contents on every request with cacheComponents both enabled and disabled. `connection()` without a Suspense boundary fails the build when cacheComponents is enabled; `io()` behind a Suspense boundary is fresh only when cacheComponents is enabled and is silently frozen when it is disabled; `export const dynamic` is unavailable when cacheComponents is enabled.

**supported · environment-matched** (derived)

Rests on: EVD-0023 (support)

### AST-0021 — The DEC-0019 read contract serves current planning content in both caching models

Under `next build` + `next start` with Next.js 16.3.2, a route whose planning-content reads each await `connection()` from `next/server` inside a `<Suspense>` boundary serves the current file contents on every request, with cacheComponents both enabled and disabled, including after an external write made while the server is running. The boundary's fallback is present in the initial HTML in both configurations, so the loading state the contract requires is observable and not merely declared. A route making the same reads without `connection()` and without a boundary builds static and serves build-time content in both configurations.

**supported · environment-matched** (derived)

Rests on: EVD-0024 (support)

### AST-0022 — A non-compliant read is silently fresh while a compliant read shares its route

Under `next build` + `next start` with Next.js 16.3.2, a planning-content read that does not follow the DEC-0019 contract is nevertheless served fresh when another read on the same route does follow it, with cacheComponents both enabled and disabled — the compliant read makes the whole route dynamic and the non-compliant sibling rides along. The non-compliant read's freshness therefore depends on the continued presence of a compliant sibling on that route, and neither the build output nor the served page distinguishes a read that is fresh because it follows the contract from one that is fresh by proximity.

**supported · environment-matched** (derived)

Rests on: EVD-0024 (support)

### AST-0023 — An MDX stage document is a program, and MDX supplies no allowlist

Under the standard MDX toolchain a `.mdx` document compiles to a JavaScript module. It may contain arbitrary JavaScript expressions — the documentation states that expressions can contain whole JavaScript programs wrapped so they evaluate to something renderable — and it may use ESM `import` and `export` to reach any module the bundler can resolve. MDX provides no mechanism that restricts which components or modules a document may reference. Its documented security position is that MDX is a programming language whose safety rests on trusting the author, and that untrusted parties should not be permitted to author MDX.

**supported · source-supported** (derived)

Rests on: EVD-0025 (support), EVD-0026 (support), EVD-0027 (support), EVD-0028 (support)

### AST-0024 — MDX's missing-component error is a diagnostic, not a boundary

MDX requires a referenced component to be defined and fails at RUNTIME when it is not, with the message `Expected component X to be defined: you likely forgot to import, pass, or provide it`. The failure occurs when a reference resolves to nothing; a document that imports a component, defines one locally, or is passed one never reaches it. The check therefore reports an authoring mistake and does not constrain what a document may reference or execute.

**supported · source-supported** (derived)

Rests on: EVD-0029 (support), EVD-0030 (support)

### AST-0025 — In `@next/mdx` the component mapping is mandatory, global, and additive

Using `@next/mdx` with the App Router requires an `mdx-components` file at the project root; the documentation states the integration will not work without it. The mapping it exports applies to all MDX files in the application rather than per document. Components passed to an individually imported MDX component merge with and override the global mapping.

**supported · source-supported** (derived)

Rests on: EVD-0031 (support), EVD-0032 (support), EVD-0033 (support)

### AST-0026 — Server-side rendering of untrusted MDX is a demonstrated code-execution class, not a theoretical one

CVE-2026-0969 (GHSA-g4xw-jxrg-5f6m, GitHub-reviewed, high severity) records arbitrary code execution during React server-side rendering of untrusted MDX: the `serialize` function used to compile MDX in `next-mdx-remote` was vulnerable due to insufficient sanitisation of MDX content. Versions from 4.3.0 up to 6.0.0 are affected and 6.0.0 is the first patched release.

**supported · source-supported** (derived)

Rests on: EVD-0034 (support), EVD-0035 (support)

### AST-0027 — The ecosystem's remedy is to remove the capability at compile time, and its protective mode is best-effort

`next-mdx-remote` 6.0.0 introduced `blockJS` and `blockDangerousJS`, both defaulting to true for security reasons, so JavaScript expressions in MDX are disabled by default from that release. With JS re-enabled, the remaining protection is described by its own maintainers as a best-effort option to block dangerous operations such as `eval`, `Function`, `process` and `require`; disabling it further is documented as safe only for content the operator completely trusts. Separately, removing `import` and `export` statements from MDX at compile time is available as a published remark plugin.

**supported · source-supported** (derived)

Rests on: EVD-0036 (support), EVD-0037 (support), EVD-0038 (support), EVD-0039 (support), EVD-0040 (support)

### AST-0028 — Making stage documents executable would export execution to package recipients — or silently drop them

The handoff publisher copies `planning-content/stages/*.md` verbatim into the published package, which currently carries nine stage documents. Because the filter matches only `.md`, converting stage documents to `.mdx` produces one of exactly two outcomes: with the filter unchanged, every stage document silently disappears from the package; with the filter widened, agent-authored documents that compile to JavaScript are shipped to whoever receives the package.

**supported · environment-matched** (derived)

Rests on: EVD-0034 (support), EVD-0041 (support)

### AST-0029 — A remark plugin that fails on forbidden nodes rejects at build time with file and position

With `@next/mdx` on Next.js 16.3.2, a remark plugin calling `file.fail` on `mdxjsEsm`, `mdxFlowExpression`, `mdxTextExpression`, `mdxJsxExpressionAttribute`, object-valued `mdxJsxAttribute`, and JSX element names outside a permitted set causes `next build` to FAIL for each of those constructs, reporting the document path and a line:column position. A document using only markdown and a permitted component builds, renders its markdown, and renders the mapped component. The plugin must be configured as an ABSOLUTE module path, because Turbopack is the default builder and `@next/mdx` resolves a relative plugin path from its own package directory.

**supported · environment-matched** (derived)

Rests on: EVD-0042 (support)

### AST-0030 — File-routed MDX is compiled into the build, so a stage document cannot be fresh

An `@next/mdx` document routed as a page is compiled to JavaScript at build time. Under `next build` + `next start`, rewriting the document while the server runs does not change what the route serves. DEC-0019's `connection()` contract cannot recover this, because the document is no longer read at request time — it has become part of the bundle.

**supported · environment-matched** (derived)

Rests on: EVD-0043 (support)

### AST-0031 — The rejection contract holds identically under runtime compilation

The same remark plugin, run through `@mdx-js/mdx`'s `compile` with `outputFormat: "function-body"` and executed with `run`, produces the same six outcomes as the bundler path: a permitted document compiles and renders its mapped component, and each of the five forbidden constructs is refused with the source path and a line:column position.

**supported · environment-matched** (derived)

Rests on: EVD-0044 (support)

### AST-0032 — A Server Component imports sibling `lib/` directly, and the client-bundle failure is unreadable without a guard

Under Next.js 16.3.2 with Turbopack, a Server Component imports a Node-only module from a sibling `lib/` directory by plain relative path — no alias, no `transpilePackages`, no bundler configuration — and the value it computes renders in the page. When the same module is reached from a `'use client'` component the build fails either way, but only the `server-only` marker makes the failure locatable: without it Turbopack reports an internal error naming no file and no position; with it the build fails at the marked file's line 1 with the source line and an explanation.

**supported · environment-matched** (derived)

Rests on: EVD-0049 (support)

### AST-0033 — The `server-only` guard cannot live in `lib/`, and works on an app-side adapter

The `server-only` package maps the `react-server` export condition to an empty module and everything else to a module that throws on import. `lib/` is imported by the CLIs in `bin/` and by the test suite under plain Node, where that condition does not apply, so marking `lib/` would make those throw. Placing the marker on a thin adapter inside the application that re-exports from `lib/` preserves both: `lib/` stays importable by plain Node, a Server Component importing the adapter builds and renders, and a `'use client'` component importing the adapter fails the build at the adapter's own line 1 with the correct App Router message. The marker therefore propagates through a re-export.

**supported · environment-matched** (derived)

Rests on: EVD-0046 (support), EVD-0050 (support)

### AST-0034 — The skeleton's idle stream and its dead stream are byte-identical, and a gap is never recovered

The walking skeleton's `/events` stream sends `retry: 500` once and then nothing until a change occurs: an idle stream emitted zero bytes over six seconds. It sends no `id:` field, so a reconnecting client has no `Last-Event-ID` to present and the server has no position to resume from; a change made while disconnected was not delivered after reconnection. A client therefore cannot distinguish an idle stream from a dead one, and cannot learn that it missed anything.

**supported · environment-matched** (derived)

Rests on: EVD-0051 (support), EVD-0053 (support), EVD-0054 (support), EVD-0055 (support)

### AST-0035 — A malformed artifact vanishes from the view while the header count still counts it

When one artifact file under the content root contains invalid JSON, the walking skeleton returns HTTP 200 with a normally-formed page, omits that artifact entirely, shows no additional lint finding, and continues to report the same artifact total as before the corruption. The rendered page therefore claims a count it did not render.

**supported · environment-matched** (derived)

Rests on: EVD-0056 (support)

### AST-0036 — An SSE comment heartbeat is invisible to page JavaScript

Per the WHATWG specification, a line in an event stream beginning with a colon is ignored by the client parser. A comment heartbeat therefore fires no event and cannot be observed by page code; the specification names its purpose as preventing legacy proxies from dropping an idle connection. Making stream health visible to a client watchdog requires a named event carrying a data field, not a comment.

**supported · source-supported** (derived)

Rests on: EVD-0057 (support), EVD-0058 (support)

### AST-0037 — `toolRoot()` survived bundling, and the reader still passes roots explicitly

Under `next build` + `next start` with Next.js 16.3.2 and Turbopack, `toolRoot()` — which resolves from `import.meta.url` inside `lib/content-root.mjs` — returned the repository root correctly from within the built server, matching `process.cwd()`. Next.js traced `lib/` rather than inlining it.

**supported · environment-matched** (derived)

Rests on: EVD-0060 (support)

### AST-0038 — MDX format inferred from a `.md` path disables the rejection contract entirely

`@mdx-js/mdx` 3.1.1 infers its parsing format from the document path when `format` is not passed. With a `.md` path it parses as plain markdown: JSX is not parsed, so a permitted component renders as a bare paragraph and a JavaScript expression compiles with no error — the rejection plugin sees no nodes to reject and reports success. Passing `format: "mdx"` explicitly restores both the component and the refusal.

**supported · environment-matched** (derived)

Rests on: EVD-0064 (support)

### AST-0039 — A refused stage document reaches the browser as a 200 and an opaque digest

Under `next build` + `next start`, when the restricted compiler throws for a document rendered inside a `<Suspense>` boundary, the response is HTTP 200 — the shell having already streamed — and the boundary's slot resolves to a React error digest with no message, path or position. The compiler's diagnostic exists but does not reach the page.

**supported · environment-matched** (derived)

Rests on: EVD-0065 (support)

### AST-0040 — A receiver-sensitive browser function can fail when copied into a collaborator object

A receiver-sensitive browser function can fail when copied into a collaborator object and later invoked as that object's method. MEASURED CASE: `const timers = { setTimeout, clearTimeout }` followed by `timers.setTimeout(fn, ms)` throws `TypeError: Illegal invocation`, because `Window.setTimeout`'s WebIDL brand check requires `this` to be the Window and the method call passes the containing object instead. Node applies no such check, so the identical code works there and every Node test of it passes. This claim covers `setTimeout` and `clearTimeout`; it does NOT assert that any other browser global behaves this way.

**supported · environment-matched** (derived)

Rests on: EVD-0075 (support)

### AST-0041 — Project trust can be granted, denied and revoked through Pi's public ProjectTrustStore API

On pi 0.84.4, `ProjectTrustStore` exported from the package root records a project trust decision that a subsequent non-interactive child honours: set(cwd, true) causes project resources to load without --approve, set(cwd, false) prevents loading, and set(cwd, null) reverts to the unloaded default. The decision is keyed by canonical directory.

**supported · environment-matched** (derived)

Rests on: EVD-0077 (support), EVD-0078 (support)

### AST-0042 — An untrusted non-interactive child loads no package and does not error

On pi 0.84.4, a `--mode json -p` child started in a project with no applicable trust decision loads none of the project package's extensions or tools, and reports no error, warning or non-zero exit attributable to trust. Where a usable model is configured the session also completes normally — observed on Linux, emitting session, agent_start, turn_start, turn_end and agent_end with the package absent.

**supported · environment-matched** (derived)

Rests on: EVD-0077 (support), EVD-0078 (support)

### AST-0043 — `pi install -l` writes a relative package entry that differs only by path separator

On pi 0.84.4, installing a project-local package writes a `packages` entry in `.pi/settings.json` that is relative to that file and contains no absolute or home-directory path. The Windows form uses backslashes and the POSIX form forward slashes; the two denote the same directory, so a forward-slash literal is a canonically equivalent committed form.

**supported · environment-matched** (derived)

Rests on: EVD-0079 (support)

### AST-0045 — A Node-spawned child on Windows receives home and user variables it was never passed

On Windows, a child process created by Node with an explicit replacement environment nonetheless receives HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, TEMP, USERDOMAIN, USERNAME, USERPROFILE and WINDIR. The same construction on Linux yields exactly the variables passed and nothing more. An environment allowlist therefore establishes a lower bound on what a child sees on Windows, and an exact set on POSIX.

**supported · environment-matched** (derived)

Rests on: EVD-0080 (support)

### AST-0046 — Pi's default active tool set includes bash, edit and write

On pi 0.84.4, a session started with no explicit tool allowlist has read, bash, edit and write active alongside any custom tools, while grep, find, ls and powershell are configured but inactive. An explicit `--tools` list narrows the active set to exactly the named tools, and a tool absent from that list is not offered to the model at all.

**supported · environment-matched** (derived)

Rests on: EVD-0081 (support)

### AST-0047 — Pi session storage can be relocated outside the project without committing a path

On pi 0.84.4 three routes relocate session transcripts, in the documented precedence order `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then the `sessionDir` setting. The command-line and environment routes are supplied at launch, so an external user-local state root is reachable without writing an absolute user path into committed configuration.

**supported · environment-matched** (derived)

Rests on: EVD-0081 (support)

### AST-0048 — A task passed as a CLI message reaches a child whose stdin is closed

On pi 0.84.4, a non-interactive child spawned with stdin closed and the task supplied as the `-p` argument receives that exact task: the text is observable in the user message sent to the provider, and the turn completes normally. Closed stdin does not prevent task delivery.

**supported · environment-matched** (derived)

Rests on: EVD-0082 (support)

### AST-0049 — A model-issued tool call reaches a registered Kiln tool with its arguments intact

On pi 0.84.4, a tool call emitted by the provider is delivered to a tool registered by a project package with its arguments intact, and the execution is observable inside the extension. A response without a tool call produces no execution, and a tool excluded from the active allowlist is neither offered to the model nor executed.

**supported · environment-matched** (derived)

Rests on: EVD-0082 (support)

### AST-0050 — A consumer resolves the pinned Pi runtime from its own .planning/node_modules

After a consumer's own `npm install` inside a tracked-file copy of the tool, the Pi CLI resolved through that copy's installed `bin.pi` reports the version this repository pins, lies within the consumer directory, and lies outside the development checkout. Verified on Windows and Linux from a generated temporary project whose git repository has no commits.

**supported · environment-matched** (derived)

Rests on: EVD-0083 (support)

### AST-0051 — Saved API-key authentication is discoverable without network access, and status alone is not availability

On pi 0.84.4, `ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false })` with `ModelRegistry` discovers configured models and provider authentication without contacting any external service. A stored api_key credential moves a model from configured-but-unavailable to available. `getProviderAuthStatus()` may report `configured: true` for a credential that `hasConfiguredAuth()` rejects and that leaves the model absent from `getAvailable()`, so provider auth status is not sufficient evidence that a model is usable.

**supported · environment-matched** (derived)

Rests on: EVD-0084 (support)

### AST-0052 — A Pi child resolves its configuration from PI_CODING_AGENT_DIR with no HOME on POSIX

On pi 0.84.4 on Linux, a child spawned with exactly PATH, TMPDIR and PI_CODING_AGENT_DIR — no HOME and no USERPROFILE, verified in the child's own report — loads the project package and completes a turn. On Windows the same construction leaves USERPROFILE present because the platform repopulates it, so the claim there is that the override is sufficient rather than that no home variable exists.

**supported · environment-matched** (derived)

Rests on: EVD-0085 (support), EVD-0086 (support)

### AST-0053 — A provider authenticated only by an environment variable is available exactly where that variable is

On pi 0.84.4, a `models.json` provider whose `apiKey` is `$VAR` yields a model that `--list-models` reports in a child carrying VAR and omits in a child without it, while an inline-key provider is reported in both. Environment authentication therefore travels with the variable and with nothing else, on Windows and Linux.

**supported · environment-matched** (derived)

Rests on: EVD-0085 (support)

## Open questions

### QST-0002 — Does `research-finding` own anything irreducible, or is it a projection?

Is there state a research-finding artifact would hold that is not already held by evidence(kind: source), assertion, or question — and that something downstream must traverse (#41)?

### QST-0022 — Should the tier-1 job model support long-lived services, or are host probes the answer for concurrent-process validation?

The validation controller runs declared commands sequentially to completion and has no form for a service that must stay running while something else is observed. Any claim about two processes interacting is therefore unvalidatable under the controller, whatever the approved ceiling permits.

### QST-0024 — How is handoff readiness inspected without publishing?

`npm run handoff` is the only way to learn whether the gates pass, and it PUBLISHES: on success it replaces `docs/plan/` with a new package. There is no read-only form, so checking readiness and performing publication are the same act, and anyone who wants the first necessarily performs the second.

### QST-0025 — What accounts for the 234-359 ms stage-document read?

`readStageDocument` measured 234-359 ms p95 across six runs. It awaits `connection()`, lists the stage directory and reads nine files totalling roughly 90 KB — work that should cost single-digit milliseconds. Which part of that span is actually spending the time, and is it reducible? INSTRUMENT BEFORE OPTIMISING: the three candidates are the `connection()` wait itself, the directory listing plus nine reads, and contention with the sibling `<Suspense>` boundary on the same request — `readStageCriteria` calls `lintProject`, which reads and validates every artifact in the project, concurrently with this read. Nothing has separated them, so all three remain live and none may be assumed.

## Tasks

### TSK-0001 — Generate role slices from the task graph

Extend the handoff renderer to emit one slice per role, as a query over tasks grouped by `role`, pulling each task's traced requirements and acceptance criteria with it. No slice is authored or maintained.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0011 · fulfils: REQ-0010, REQ-0011*

### TSK-0002 — Derive stage 6's scope from graph use rather than a flag

Replace `load-bearing-assertions-at-rung`'s reliance on the optional `loadBearing` flag with a scope derived from the graph — at minimum, every assertion referenced by an active runbook step's `restsOn`.

**accepted** (2/2 criteria passed) · role: platform
*Implements: CMP-0002 · fulfils: REQ-0009*

### TSK-0003 — Scaffold the Next.js application and its production build/start primitives

Create the application under `app/` and make `next build` followed by `next start` work on loopback, with a route that responds. No MDX integration of any kind is configured here. The documented one-command launcher is TSK-0013's.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0020 · fulfils: REQ-0020*

### TSK-0004 — Build the `app/server/*` adapter layer over `lib/`

Create the adapter modules the shell needs, each beginning with `import 'server-only'` and re-exporting by explicit name or wrapper. Expose only the capabilities the first slice requires. `lib/` itself is not modified and gains no marker, so `bin/` and the test suite keep working under plain Node.

**accepted** (3/3 criteria passed) · role: platform
*Implements: CMP-0014 · fulfils: REQ-0019*

### TSK-0005 — Build the planning-content reader on the `connection()` + Suspense contract

Implement the single read path: await `connection()` before each filesystem read, with every read site enclosed by a `<Suspense>` boundary whose fallback names the content it stands in for. Reads reach `lib/` only through the adapter.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0012 · fulfils: REQ-0016, REQ-0017, REQ-0018*

### TSK-0006 — Build the static `app/server` → `lib/` import-boundary check, with failing fixtures

Implement the analysis that runs without executing the application and reports file and line when any module outside `app/server/` imports from `lib/`, whether directly or through a re-export chain that reaches `lib/` indirectly. Ship fixtures containing both shapes and prove the check fails on each.

**accepted** (2/2 criteria passed) · role: platform
*Implements: CMP-0014, CMP-0019 · fulfils: REQ-0019, REQ-0021*

### TSK-0007 — Build the project view's stage navigation and derived current stage

Render `/`: the current stage derived from stage definitions and recorded attestations, and all nine stages with their gate state. Status is conveyed by text or icon, never by colour alone. No stored status field is introduced anywhere.

**accepted** (1/1 criteria passed) · role: frontend
*Implements: CMP-0015 · fulfils: REQ-0016*

### TSK-0008 — Build the restricted MDX compiler with rejection diagnostics

Compile stage documents at request time with `@mdx-js/mdx`, running a remark plugin that FAILS the compile — naming the document path and a line:column — on any ESM import or export, JavaScript expression, JSX attribute expression, JSX spread attribute, or JSX element outside the permitted set. Surface the failure to the operator. Stripping may sit beneath the rejection as defence in depth and may never be the observable behaviour.

**accepted** (3/3 criteria passed) · role: platform
*Implements: CMP-0013 · fulfils: REQ-0017*

### TSK-0009 — Build the stage view: criteria above the document, artifact-scoped review

Render `/stage/[stageId]`: the stage's exit criteria with their recorded attestations, then the compiled document, then a review panel identifying the artifact under review by id, type, title and current status. Long criterion identifiers wrap rather than overflow.

**accepted** (3/3 criteria passed) · role: frontend
*Implements: CMP-0016 · fulfils: REQ-0017, REQ-0019*

### TSK-0010 — Put every correctness-critical selection in the URL

Encode the selected stage and the selected artifact in the URL so that opening it in a session with no prior client storage restores the same selection. Transient interface state may remain in the client.

**accepted** (1/1 criteria passed) · role: frontend
*Implements: CMP-0015, CMP-0016 · fulfils: REQ-0016*

### TSK-0011 — Build the change-stream server: watcher, transport, named heartbeat, failure propagation

Watch the content root and deliver change hints over an event stream. Emit a NAMED heartbeat event carrying data at a fixed interval. When the watcher fails, emit a visible failure signal on the stream or close the stream; logging alone is not permitted.

**accepted** (2/2 criteria passed) · role: platform
*Implements: CMP-0017 · fulfils: REQ-0018*

### TSK-0012 — Expose the review-status write through the adapter, with individual review

Expose `lib/tools/review-status.mjs` through the adapter and wire the stage view's review panel to it. Updating changes only the named artifact's `reviewStatus`, through the existing lock and atomic write; `lifecycle` and every other artifact are unchanged.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0018 · fulfils: REQ-0019*

### TSK-0013 — Own the documented one-command launcher, and prove its cleanup

Provide the single documented command that installs, builds and starts the application in production mode. It launches Next directly as its owned child rather than through a nested npm process, sets and PRINTS an absolute `PLANNING_CONTENT_DIR`, binds loopback explicitly, forwards shutdown to the child, waits for it to exit, and escalates within a bounded time if it does not. Verify cleanup by observation after termination: the child PID is gone, nothing is listening on the port, and no temporary directory the launcher created survives. The cleanup test must first open `/events` and observe a heartbeat, so that a watcher is known to have existed before anything claims it was released.

**accepted** (2/2 criteria passed) · role: platform
*Implements: CMP-0020 · fulfils: REQ-0020*

### TSK-0014 — Run the compile benchmark under the pinned protocol

Measure the 95th-percentile server-side compile-and-render time for the largest stage document under ACC-0020's protocol: pinned environment recorded with the result, timing from read to completed markup, ten discarded warm-up requests, fifty measured serial requests, and per-request verification that compilation occurred. Record the result as evidence.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0013 · fulfils: REQ-0017*

### TSK-0015 — Build the static planning-read and `<Suspense>` confinement check, with failing fixtures

Implement the analysis that runs without executing the application and reports file and line for a planning-content filesystem read performed anywhere other than the reader, and for a read site not enclosed by a `<Suspense>` boundary. Ship fixtures containing both violations and prove the check fails on each.

**accepted** (3/3 criteria passed) · role: platform
*Implements: CMP-0019 · fulfils: REQ-0021*

### TSK-0016 — Build the project view's artifact totals, lint surface and located parse failures

Add to `/`: artifact totals for each type, lint findings surfaced rather than re-judged, and reporting for a file that fails to parse — named with its path and a position, omitted from the page, and subtracted from its type's total. No rendered total may include an artifact the page did not render.

**accepted** (2/2 criteria passed) · role: frontend
*Implements: CMP-0015 · fulfils: REQ-0016*

### TSK-0017 — Build the change-stream client: listener, watchdog, stale state, reload on reconnect

Subscribe to the stream, listen for the named heartbeat event, and run a watchdog that renders a visibly stale state — by text or icon, not colour alone — when a heartbeat does not arrive within its window. Reload on a change hint and on reconnection. No event buffer, event id or `Last-Event-ID` handling.

**accepted** (2/2 criteria passed) · role: frontend
*Implements: CMP-0017 · fulfils: REQ-0018*

### TSK-0018 — Stand up the disposable clean-consumer fixture the spike runs in

Build a throwaway outer project — git init with no commits, a tracked-file-only copy of the tool as `.planning`, no pre-existing Pi trust decision, and a recorded starting state for every user and host location the spike will touch — so that each observation begins from a machine state the run itself established rather than one it inherited.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0041 · fulfils: REQ-0005, REQ-0006, REQ-0024*

### TSK-0019 — Measure trust grant, denial and revocation against the pinned runtime

Determine whether 0.84.4 exposes a supported API, command or non-interactive option for recording, reading and revoking a project trust decision. Observe the result through a marker written at extension load time, upstream of any model behaviour, with the 2026-08-18 control set: untrusted, granted, explicitly denied, and grant removed. Record the answer to QST-0026 and stop for review if no supported route exists.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0041 · fulfils: REQ-0005, REQ-0006, REQ-0024*

### TSK-0020 — Measure configuration and auth resolution on both platforms, default and overridden

Establish which configuration-locating variables 0.84.4 consults to find its authentication store and custom-model registry, under both default directories and an explicitly overridden one, on Windows and POSIX; and confirm a restricted child carrying only those variables resolves the same store as its parent. Record the answer to QST-0029 as the measured base allowlist.

**accepted** (2/2 criteria passed) · role: platform
*Implements: CMP-0041 · fulfils: REQ-0005, REQ-0006, REQ-0024*

### TSK-0021 — Measure the package entry, package loading and session relocation

Record the literal entry `pi install -l` writes and whether it can be normalised to a portable relative form with canonical equivalence proved; confirm the installed package loads its extensions, tools, skills, prompts and capability signature; and determine whether session and runtime directories can be relocated outside the project through a supported option. Answers QST-0027 and QST-0028.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0041 · fulfils: REQ-0005, REQ-0006, REQ-0024*

### TSK-0022 — Measure closed-stdin task binding and re-check the carried-over 0.80.6 findings

Confirm a `--mode json -p --no-session` child with closed stdin can receive its exact task through the supported non-stdin channel, with an observation taken at the child. Re-run the five behaviours recorded against 0.80.6 — silent untrusted load, trust store shape, skill override precedence, default active tool set, turn-end hooks in a non-interactive child — and record which still hold. Answers QST-0030 and QST-0031.

**accepted** (2/2 criteria passed) · role: platform
*Implements: CMP-0041 · fulfils: REQ-0005, REQ-0006, REQ-0024*

### TSK-0023 — Promote the spike fixtures into the normal test suite

Retain each proof, with its control and its redaction assertions, as a test that runs in CI, so that a later change to the pinned Pi version has to re-prove the contract rather than inherit it. Tests that require a real provider stay manually invoked and out of default CI.

**accepted** (2/2 criteria passed) · role: platform
*Implements: CMP-0041 · fulfils: REQ-0005, REQ-0006, REQ-0024*

### TSK-0024 — Build the pinned Pi resolver and version gate

Add `lib/pi-runtime.mjs`: resolve the CLI entry point from the tool root's node_modules, report the installed version, refuse a mismatch against the pin, and spawn through the current Node executable with shell interpolation disabled. Add the pinned dependency and raise engines.node per DEC-0026.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0021 · fulfils: REQ-0022, REQ-0028*

### TSK-0025 — Add project-root resolution to the shared resolver

Extend `lib/content-root.mjs` with `projectRootCandidate()` and `resolveProjectRoot()` so the directory that owns `.pi/`, `.gitignore`, Pi's working directory and runtime state has one authority, per decision #70's rule that no caller joins its own path.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0003 · fulfils: REQ-0022*

### TSK-0026 — Build the setup transaction: one lock, preflight, write plan and journal

Add `lib/setup-transaction.mjs` owning the existing `.planning-init.lock` for the whole command: canonicalise and print targets, schema-validate readable files, probe temp-create and atomic rename in each parent, hash existing files, compare under the lock before each merge, and keep a non-secret resumable journal.

**accepted** (5/5 criteria passed) · role: platform
*Implements: CMP-0022 · fulfils: REQ-0022, REQ-0027*

### TSK-0027 — Make the initializer and the ignore owner accept a held transaction

Change `lib/initialize-project.mjs` and the shared ignore owner to run inside an already-held transaction rather than acquiring their own lock, preserving their current idempotency and refusal semantics and their existing tests.

**accepted** (2/2 criteria passed) · role: platform
*Implements: CMP-0022 · fulfils: REQ-0022, REQ-0027*

### TSK-0028 — Extract the single ignore owner and add legacy block migration

Move the existing planning, append-safety, line-ending and recorded-idempotency logic out of `lib/initialize-project.mjs` into `lib/project-gitignore.mjs` used by both initialization and setup, and add the exact-legacy-block migration under the same lock and atomic-write discipline.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0023 · fulfils: REQ-0027*

### TSK-0029 — Build the locked atomic schema-aware settings merge

Add `lib/pi-settings.mjs`: read under the transaction, validate the existing shape, merge only the package entry, skill-override path, provider/model/thinking defaults and session directory, write atomically through a same-directory temporary file, and produce identical bytes when the desired state already holds.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0024 · fulfils: REQ-0024, REQ-0025*

### TSK-0030 — Normalise the package entry only after proving canonical equivalence

Compare the literal entry `pi install -l` wrote against the portable `../.planning/pi-package` form, prove both canonicalise to the same directory on this platform, and rewrite only on proof. Refuse when equivalence cannot be established rather than constructing a target.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0024 · fulfils: REQ-0024, REQ-0025*

### TSK-0031 — Implement the local-state policy and its two modes

Derive and create the chosen state root, enforce coverage-before-data, generate and persist the stable non-secret project ID once, and pass external session and runtime locations through the route the spike proved. Withdraw the external mode if QST-0027 comes back negative.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0025 · fulfils: REQ-0027, REQ-0023*

### TSK-0032 — Integrate project trust through the route the spike established

Implement obtaining, reading and reporting the trust decision per DEC-0027, including the non-interactive refusal and the browser-only fallback. If QST-0026 found no supported programmatic route, remove or defer the `--trust` option and document the manual step instead.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0026 · fulfils: REQ-0023, REQ-0026*

### TSK-0033 — Build permission-gated connection inspection

Implement the inspection prompt and, only after approval, sanitised discovery through the supported surface: `ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false })` with `ModelRegistry`, reading availability from `getAvailable()` — never `getAll()`, which returns the entire built-in catalogue — plus `getProviderDisplayName()` and `hasConfiguredAuth()`, and the root-exported `readStoredCredential` where a presence-only read is needed. Add the presence-only check for the known provider variables and the research credential. Instrument each access point so the before-consent criterion is observable.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0027 · fulfils: REQ-0023, REQ-0024*

### TSK-0034 — Build the local consent record and its invalidation rules

Persist the host-specific grant in the ignored local-state root, keyed so that a provider or research change invalidates it, and read it at launch so an unchanged project does not re-prompt while a new machine does.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0027 · fulfils: REQ-0023, REQ-0024*

### TSK-0035 — Implement the Tavily consent, probe and plain-English outcomes

After a separate approval, run the existing `GET /usage` capability probe from `lib/research/tavily-adapter.mjs`, persist the non-secret project choice and the local approval, and map each internal state to its required user-facing wording. Declining leaves research unavailable and does not block planning.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0027 · fulfils: REQ-0003, REQ-0012*

### TSK-0036 — Build model discovery, explicit selection and persistence

Present available providers and exact model identifiers, validate any supplied `--provider`/`--model`/`--thinking` against the registry, require confirmation, state the billing consequence, and persist the exact identifiers through the settings merge per DEC-0028.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0028 · fulfils: REQ-0025, REQ-0012*

### TSK-0037 — Build the launch-time availability checks and the refusal path

At every launch resolve the recorded selection, verify an authentication source is configured, verify the package and required tools loaded, verify a matching compatibility record exists, and refuse the run with a specific reason when any check fails.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0028 · fulfils: REQ-0025, REQ-0023*

### TSK-0038 — Build the audited provider credential contract table

Add `lib/pi-provider-credentials.mjs` declaring, per supported provider, the id, supported auth source categories, and the exact required and optional model-plane variable names — names only, never values — plus the validated declarative shape by which a custom provider may contribute names.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0029 · fulfils: REQ-0024, REQ-0026*

### TSK-0039 — Build child environment construction and prove it with sentinels

Construct each child's environment as the union of the measured base runtime and configuration variables, the selected provider's model-plane names and the role's tool-plane names, and prove the boundary with sentinel variables that must not cross it. Extend the existing `childEnv()` in `lib/specialists/contract.mjs` rather than adding a parallel builder.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0029 · fulfils: REQ-0024, REQ-0026*

### TSK-0040 — Prove the contract with a disposable restricted child before accepting it

Spawn a throwaway restricted Pi child that resolves the exact provider and model and reports only availability and the auth-source category — never variable names, values, headers or credential-derived fingerprints — and refuse the contract if it cannot.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0029 · fulfils: REQ-0024, REQ-0026*

### TSK-0041 — Build the setup-only preflight tool and the bounded canary request

Register `kiln_preflight` outside the orchestrator registry, accepting only the one-time challenge schema and returning a fixed acknowledgement with no access to content, mutation, research, validation, delegation or shell; issue the canary under a low token ceiling and remove the tool from the effective set before the user-facing session starts.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0030 · fulfils: REQ-0012, REQ-0023, REQ-0025, REQ-0028, REQ-0024*

### TSK-0042 — Build the zero-cost preflight and the compatibility record

Check configuration, auth availability, model resolution, package loading and tool signatures at no cost; store canary success keyed to its exact inputs in the local-state root; and implement every invalidation input so a changed key reopens approval.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0030 · fulfils: REQ-0012, REQ-0023, REQ-0025, REQ-0028, REQ-0024*

### TSK-0043 — Create the Pi package manifest, entry point and capability signature

Add `pi-package/` with a declared package manifest naming extensions, skills and prompts, a registration entry point, and a machine-readable capability signature that the supervisor, the canary and the delegation verifier can each compare against what they expected.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0031 · fulfils: REQ-0026, REQ-0028*

### TSK-0044 — Register the read, mutation and attestation tools over the existing registries

Wrap project status and lint reads, `TYPED_TOOLS`, `MUTATION_TOOLS`, `PROJECT_TOOLS` and the stage-attestation read and write operations as validated Pi tools, and launch the session with Pi's built-in mutation tools disabled.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0032 · fulfils: REQ-0024, REQ-0001, REQ-0002*

### TSK-0045 — Register the research, validation and delegation adapters

Expose `research_capability`, `research_search`, `research_fetch`, `validation_capability`, `validation_run`, specialist delegation and the Kiln capability signature over the existing `lib/research/` and `lib/validation/` implementations without restating their rules.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0032 · fulfils: REQ-0003*

### TSK-0046 — Build the stage-skill generator and its check mode

Generate one skill per canonical stage definition covering purpose, decision owner, outputs, exit criteria, method, next-activity selection, allowed delegations, mutation and approval boundaries and the completion summary, with a `--check` mode that fails on staleness.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0033 · fulfils: REQ-0001*

### TSK-0047 — Register the consumer override path and test all four override states

Register `planning-content/skills-overrides/` after the packaged skills and cover the packaged-only, override-present, override-edited and override-removed cases through a real Pi resource load.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0033 · fulfils: REQ-0001*

### TSK-0048 — Implement the orchestrator context, policy and the /kiln-start entry

Build the persistent session behaviour: resolve and guard the content root, derive the current stage from definitions and attestations, load the matching skill, and register the start prompt that begins Stage 1 on a fresh project or summarises stage, blockers and the single recommended next action on an existing one.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0034 · fulfils: REQ-0022, REQ-0001*

### TSK-0049 — Implement adaptive question selection and continuous intake capture

Choose each next question by information value and blocking impact rather than from a fixed list, keep the operator's wording separate from interpretation, update the intake document continuously through typed tools, and run lint after material mutations without paraphrasing findings away.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0034 · fulfils: REQ-0022, REQ-0001*

### TSK-0050 — Implement the approval and attestation boundary

Make the orchestrator show material proposed changes before making them, require the operator's decision where the stage says the decision is theirs, and refuse to approve an artifact or satisfy a user-owned exit criterion under any prompting.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0034 · fulfils: REQ-0022, REQ-0001*

### TSK-0051 — Author the three role definitions and the roster lint

Write `research.md`, `planning.md` and `validation.md` declaring name, description, tool allowlist, input contract, responsibilities, forbidden actions, output schema, exit criteria and escalation conditions, deriving write boundaries from `lib/specialists/contract.mjs`; add the lint that fails a role with no declared tools.

**outstanding** (0/2 criteria passed) · role: platform
*Implements: CMP-0035 · fulfils: REQ-0026, REQ-0025*

### TSK-0052 — Replace stdinDelivered with an observed task-binding result

Change `verifyChild()` in `lib/specialists/contract.mjs` from `stdinDelivered` to an independently observed task-binding outcome, rename `CHILD_REFUSED.NO_STDIN` and its detail text to describe a missing task binding, and update the existing tests so both facts are asserted together.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0009 · fulfils: REQ-0026*

### TSK-0053 — Build the delegation extension: launch, binding, inheritance and cleanup

Implement child launch with `--mode json -p --no-session`, shell disabled and stdin closed; private restricted-permission prompt files; task-scoped context; exact model inheritance; the intersected tool allowlist; bounded timeout with abort propagated to the process tree; and deletion of temporary material on every exit path.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0036 · fulfils: REQ-0026, REQ-0025, REQ-0024*

### TSK-0054 — Build capability-signature verification and the refusal matrix

Verify the child's Kiln capability signature before reading its substantive answer, and cover each refusal cause with a test, including the fake child that returns plausible prose with none of Kiln's tools. This is the detection half of decision #67 that has never been built.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0036 · fulfils: REQ-0026, REQ-0025, REQ-0024*

### TSK-0055 — Add the run-identity health route

Add the Kiln health endpoint to the application, taking the run and project identifiers supplied by the supervisor at start, and returning only the identity fields.

**accepted** (1/1 criteria passed) · role: frontend
*Implements: CMP-0038 · fulfils: REQ-0028*

### TSK-0056 — Isolate application stdin and support supervised launcher control

Change `bin/start-shell.mjs` to validate the run identifier, project identifier and port it is given, propagate the identity to the application it starts, keep its own stdin as its control channel while giving the application none, and stop on both the stop message and stdin close — preserving its existing interactive standalone behaviour and its current cleanup tests. On a piped stdin, standalone or supervised, closing the pipe stops the launcher; that is intended rather than preserved. Whether terminal input reaches Pi rather than the launcher is the supervisor's to establish and belongs to TSK-0057.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0020 · fulfils: REQ-0022*

### TSK-0057 — Build the supervisor's start sequence and identity handshake

Implement `bin/start-kiln.mjs`: validate project and settings, parse and bind-test the port, generate the run identifier, start the launcher with a private stdin, poll the Kiln health endpoint for matching service, protocol, run, project and build identity while the expected child is alive, then start Pi in the outer project root with the terminal inherited.

**outstanding** (0/3 criteria passed) · role: platform
*Implements: CMP-0037 · fulfils: REQ-0028, REQ-0020, REQ-0022*

### TSK-0058 — Build session resumption and bounded shutdown

Send the start prompt on a first session and resume the recorded Kiln session afterwards, recovering by presenting available sessions when the record is missing or corrupt rather than resuming an unrelated generic session; stop both trees on Pi exit and on signals with bounded escalation, on Windows and POSIX.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0037 · fulfils: REQ-0028, REQ-0020, REQ-0022*

### TSK-0059 — Implement the self-host refusal and its explicit opt-in

Refuse the consumer command when the tool root and project root coincide, and implement the two-part opt-in with agreement verified before start, covered separately so it can never weaken the consumer-root checks.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0037 · fulfils: REQ-0028, REQ-0020, REQ-0022*

### TSK-0060 — Compose the ordered setup command over the existing primitives

Implement `bin/setup.mjs` running the ordered phases from path resolution through initialization, state protection, install, trust, package registration, consent, model binding, credential contract, research choice, preflight, canary and read-back, with dynamic imports after the install step and no second initializer.

**outstanding** (0/4 criteria passed) · role: platform
*Implements: CMP-0039 · fulfils: REQ-0022, REQ-0027*

### TSK-0061 — Implement the argument surface, refusal codes and non-interactive contract

Implement the documented flags including the explicit consent options, reject API keys as arguments, refuse on any missing decision in non-interactive mode, and publish the exit-code mapping in `--help` and in tests.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0039 · fulfils: REQ-0022, REQ-0027*

### TSK-0062 — Build the deterministic non-billable provider fixture

Stand up a local provider the pinned runtime can resolve as a custom model, answering deterministically and able to emit a correctly shaped tool call, so the canary and the Stage 1 exchange are testable in CI without a paid account or a network dependency.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0040 · fulfils: REQ-0022, REQ-0020, REQ-0028, REQ-0023*

### TSK-0063 — Build the clean-consumer end-to-end journey test

Automate the documented sequence from an empty directory through setup, the Stage 1 exchange, the browser observation, the refused advance, shutdown and the resuming rerun, on Windows and the supported POSIX CI platform.

**outstanding** (0/3 criteria passed) · role: platform
*Implements: CMP-0040 · fulfils: REQ-0022, REQ-0020, REQ-0028, REQ-0023*

### TSK-0064 — Build the negative-control suite

Automate each enumerated wrong state as its own case asserting the specific refusal, so that a regression which turns any of them into an apparent success fails a named test.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0040 · fulfils: REQ-0022, REQ-0020, REQ-0028, REQ-0023*

### TSK-0065 — Observe Pi's authentication-only TUI behaviour, including the no-TTY case

Establish, against the pinned runtime and with nothing of Kiln's involved, what Pi's interactive `/login` step does: whether it can be launched with exclusive terminal ownership, what its exit conveys and whether authentication must be rediscovered afterwards rather than inferred from the exit code, and what happens when it is invoked with no TTY — refusal, error, or an indefinite wait. Record it as a manually invoked check with its transcript retained, because it needs a real terminal and cannot run in the default suite.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0027 · fulfils: REQ-0022, REQ-0025*

### TSK-0066 — Run the manual, account-bound OAuth compatibility check

Against a real subscription and outside CI: run Pi's interactive `/login` with an isolated configuration directory and a sanitized environment; after it exits, construct a fresh `ModelRuntime` and `ModelRegistry` and record whether the chosen built-in model appears in `getAvailable()` and passes `hasConfiguredAuth()`; then remove or revoke the stored credential and record that the model becomes unavailable. Retain a sanitized single-instance evidence record — no token, header, credential-derived value, username or home path — and label it as manual and account-bound so it is never mistaken for a suite result.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0027 · fulfils: REQ-0022, REQ-0025*

### TSK-0067 — Prove the Kiln capability signature loads and can be compared

Once the Kiln Pi package exists, extend the compatibility suite to observe that its machine-readable capability signature is present in a loaded session and that a deliberate change to a measured tool signature is detected by a comparing consumer. Until then the suite proves extension, skill and prompt loading only.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0031 · fulfils: REQ-0022, REQ-0025*

### TSK-0068 — Implement setup's TTY precondition and its two recovery routes

Before setup launches the authentication-only login step, check for a real TTY. With no TTY and no usable authentication already present, refuse without spawning the login process and print both documented recovery routes with the exit code reserved for interactive authentication being required. With authentication already present, continue through the non-interactive contract instead.

**outstanding** (0/1 criteria passed) · role: platform
*Implements: CMP-0039 · fulfils: REQ-0022*

### TSK-0069 — Make unlinkTrace able to remove an invalid or stale link

Stop validating the target type when removing a link, so a wrong-target, dangling or superseded reference can be withdrawn through the typed path, and give `answeredBy` a removal route it has never had. Keep the unknown-field refusal, and keep the lock, fresh read inside it, and atomic write. Cover the wrong-target, dangling and superseded cases with tests, each asserting the lint finding it clears.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0005 · fulfils: REQ-0014*

### TSK-0070 — Derive reviseArtifact's trace-field guard from the schemas

Replace the hardcoded array of seventeen trace-like field names with a derivation over the schema set's `x-traceTarget` declarations, using the existing effective-schema resolver rather than re-reading schemas independently. Every declared trace field is then refused by construction, and adding one to a schema needs no code change.

**accepted** (1/1 criteria passed) · role: platform
*Implements: CMP-0005 · fulfils: REQ-0013, REQ-0014*

## Retired and superseded

⚠️ **Not part of the current plan.** Listed because removing them silently would make this
rendering disagree with the machine-readable data, which is the parity REQ-0011 requires.

- **ACC-0020** (acceptance-criterion, superseded) — Per-request compilation stays within 300 ms at p95, under a pinned protocol
- **AST-0007** (assertion, superseded) — With Cache Components, a SYNCHRONOUS fs read freezes into the static shell
- **AST-0044** (assertion, superseded) — A Pi child resolves its configuration from PI_CODING_AGENT_DIR alone, with no HOME
- **RBS-0001** (runbook-step, retired) — Run specialists in parallel
- **REQ-0015** (requirement, retired) — The system runs locally for a single operator
