# Kiln runnable agent-delivery layer

## Updated technical implementation proposal

**Status:** Proposed implementation specification
**Audience:** Kiln maintainers and implementing developers
**Last verified against this repository:** 2026-09-02
**Pi version inspected for this proposal:** `@earendil-works/pi-coding-agent` 0.80.6

## 1. Purpose

Kiln already has a functioning planning-content model, typed mutation layer, stage gates, research
and validation primitives, browser application, project initializer, and deterministic handoff
publisher. It does not yet deliver the user-facing agent experience described by the product design.

This proposal specifies the remaining work required to make a clean consumer installation behave as
one product:

1. initialize a Kiln planning workspace;
2. configure a usable Pi inference provider and model without storing secrets in the project;
3. load Kiln's project-local Pi package;
4. start the browser workspace and the Pi orchestrator;
5. immediately begin or resume the adaptive Stage 1 interview;
6. delegate bounded work to the research, planning, and validation specialists; and
7. prove the complete journey with clean-consumer tests.

This document supersedes any use of the phrase **"application launch"** that could be read as
starting only the Next.js application. Agent delivery is not complete unless Pi starts successfully,
loads Kiln, resolves a usable model, and begins or resumes the planning conversation.

## 2. Verified current state

As of the verification date:

- `npm test` passes all 451 tests.
- `npm run lint:plan`, with `PLANNING_CONTENT_DIR` pointed at this repository's own planning content,
  reports no findings across 261 artifacts.
- `bin/init-project.mjs` creates and validates `planning-content/`, but deliberately does not install
  dependencies, configure an LLM, install an agent package, start Pi, or conduct intake.
- `npm start` invokes `bin/start-shell.mjs`; it installs application dependencies when necessary,
  builds Next.js, and starts the browser workspace on loopback. It does not launch Pi.
- No `pi-package/` directory exists.
- `package.json` has no Pi runtime dependency or agent-launch script.
- The role contract logic in `lib/specialists/contract.mjs` is tested, but nothing launches a real
  Kiln specialist through it.
- The typed functions in `lib/tools/`, `lib/research/`, `lib/validation/`, and `lib/attestations.mjs`
  are library functions. They are not registered as Pi extension tools.
- There is no runnable orchestrator and there are no generated stage skills.
- The existing project plan can report green gates while this product half is absent because the
  missing work is not represented by active, traceable requirements, components, acceptance
  criteria, and tasks.

The passing baseline must be preserved. It is evidence for the existing application and planning
engine, not evidence that the agent-delivery layer exists.

## 3. Important findings beyond the original assessment

### 3.1 Pi currently starts nowhere

The documented consumer commands end with `npm --prefix .planning start`. That command starts the
browser application only. Running `pi` manually would start a generic Pi session without Kiln's
orchestrator, tools, skills, or specialist roster.

The completed setup must therefore own an explicit transition from **workspace initialized** to
**Kiln-aware Pi session running**.

### 3.2 The Pi runtime itself must be reproducible

Depending on an arbitrary global `pi` executable leaves the consumer's behavior dependent on PATH
and an unrecorded version. Add an exact Pi version to Kiln's runtime dependencies and invoke that
local binary for setup, package installation, the user-facing session, and every specialist child.

For the first implementation, pin the version that the agent layer is developed and tested against.
Version 0.80.6 is the inspected baseline for this proposal; changing it must be an intentional,
tested dependency update. Because that Pi release requires Node 22.19.0 or later, Kiln's current
`engines.node` declaration of `>=22` must be raised accordingly if 0.80.6 is selected.

The launcher must resolve Pi from `.planning/node_modules`, never by executing an unqualified `pi`
from PATH. A global Pi installation may exist, but it is not the Kiln runtime contract.

### 3.3 Authentication and project model selection are different state

Pi authentication is user- or host-scoped. The selected Kiln provider/model is project-scoped.
They must not be conflated:

| State | Location | May contain secrets? | Commit? |
| --- | --- | --- | --- |
| OAuth/API credentials | Pi user auth store, environment, or user `models.json` | Yes | Never |
| Kiln package registration | `<project>/.pi/settings.json` | No | Yes |
| Default provider/model/thinking level | `<project>/.pi/settings.json` | No | Yes, unless the user explicitly chooses a local-only override policy |
| Pi trust decision | Pi's user trust store | No secret, but user-specific | Never |
| Session files and local launch state | `<project>/.pi/sessions/` and `<project>/.pi/runtime/` | Potentially sensitive | Never |
| Research credential | Host environment or user credential store | Yes | Never |

The project settings file chooses an exact provider and exact model ID. It must contain no API key,
OAuth token, research key, absolute home path, or copied credential material.

### 3.4 The root session and specialist children have different credential boundaries

`lib/specialists/contract.mjs` currently builds a restricted child environment containing base OS
variables and, for research only, `TAVILY_API_KEY`. That is insufficient when Pi inference itself is
authenticated exclusively through an environment variable such as `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`: the orchestrator can run, but every specialist child will lose the model
credential and fail inference.

The implementation must distinguish:

- **model-plane credentials**, needed by the orchestrator and every Pi child using that provider;
- **tool-plane credentials**, such as `TAVILY_API_KEY`, exposed only to the role that owns that tool.

Prefer Pi's user auth store because children can use it through the inherited Pi configuration
location without placing a credential on the command line. If the selected provider is authenticated
only through the environment, pass only that provider's required variables to every Pi child. Never
pass all of `process.env`, and never pass an API key using Pi's `--api-key` option because command-line
arguments may be visible in process listings.

The base child allowlist must carry the variables needed to resolve Pi's user configuration on every
supported platform: `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, and
`PI_CODING_AGENT_DIR`, in addition to the existing process/runtime variables. Absence is preserved as
absence; setup must not invent values. The compatibility spike in section 17 must observe which path
the pinned Pi version actually uses on Windows and POSIX with both default and explicitly overridden
configuration, then pin tests to those observations. Children must resolve the same auth store and
custom-model registry as the parent.

### 3.5 The existing stdin verification contradicts the subprocess contract

The approved child process contract is `stdio: ["ignore", "pipe", "pipe"]`: stdin is closed so a
non-interactive Pi process cannot wait forever for input. The task must be supplied as a CLI message
or through a private temporary prompt file.

`verifyChild()` currently requires `stdinDelivered: true` and describes failure as a task not being
delivered on stdin. This is internally contradictory. Replace that field with an independently
observed `taskDelivered` or `promptBound` result. Rename `CHILD_REFUSED.NO_STDIN` and its detail text
to describe a missing task binding rather than stdin. Tests must prove both of these facts at once:

- stdin is closed; and
- the exact delegated task reached the child through the supported non-stdin channel.

### 3.6 Specialist model declarations must not defeat project selection

Hard-coding `model:` in each specialist definition can silently override the provider/model chosen
during setup. In v1, specialists inherit the exact active orchestrator provider, model, and supported
thinking level. The delegation extension passes those exact values to the child process.

Role-specific model overrides may be added later as explicit project configuration. They must never
be inferred from a role definition shipped with Kiln, and an unavailable override must fail clearly
rather than fall back to a different model.

### 3.7 Browser and Pi are separate processes and need one lifecycle owner

The v1 design intentionally keeps Pi in the terminal beside the browser. This means a complete
one-command experience has at least two live processes:

- the existing application launcher, which owns the Next.js server; and
- the interactive Pi process, which owns the user's planning conversation.

A new supervisor must coordinate both without allowing the background application launcher to read
the terminal input intended for Pi. The application launcher's stdin must be a private pipe; Pi alone
inherits the terminal. When Pi exits, the supervisor sends the existing `stop` control message to the
application launcher and waits for bounded cleanup. Signals must be forwarded to both process trees.

### 3.8 Session state must not dirty the `.planning` clone

The tool repository is updated with `git pull`, so runtime session files must not be written inside
the `.planning` clone. Store the user-facing session under the outer project's `.pi/sessions/` and
local supervisor state under `.pi/runtime/`. Add those two paths to the outer project's `.gitignore`;
do not ignore `.pi/settings.json`, which is the reproducible, non-secret project configuration. This
intentionally amends canonical decision #29, which previously placed session state under
`.planning/`. The decision record and its layout diagram must be updated in the same change so only
one answer remains live.

### 3.9 The project root needs one canonical resolver

The existing shared module resolves the tool root and content root, but it does not export the
project root that owns `.pi/`, `.gitignore`, Pi's working directory, and runtime state. Deriving it in
each caller would recreate the path disagreement that decision #70 forbids.

Add `projectRootCandidate()` and `resolveProjectRoot()` to the shared resolver. Runtime project-root
resolution is always based on the resolved content root: `projectRoot = dirname(contentRoot)`. With
`PLANNING_CONTENT_DIR` set, the project root is therefore the canonical parent of that explicit
content directory, never `<toolRoot>/..`. Setup additionally receives an explicit `--project-root`,
canonicalizes it, and verifies that it agrees with the resolved content owner before writing. A
mismatch is a refusal that prints both paths and the override; no caller chooses one silently.

### 3.10 Setup must merge settings rather than replace them

`pi install -l` writes project settings. Kiln also needs to add its override-skill path and selected
model defaults. Setup must perform a lock-protected, atomic, schema-aware merge that preserves every
unrelated user setting and package entry. A malformed settings file is a refusal, not permission to
replace it. Re-running setup must change no bytes when the desired state is already present.

### 3.11 `.gitignore` remains a single-owner operation

`lib/initialize-project.mjs` already owns `.gitignore` planning, append safety, recorded idempotency,
and the rule that a deliberately deleted Kiln block is not restored. Setup must not introduce an
independent appender.

Refactor that existing logic into one shared owner used by both initialization and setup. Fresh
projects receive one Kiln-owned block containing `.planning/`, `.pi/sessions/`, and `.pi/runtime/`.
For existing setup-version-1 projects, migrate only an exact, unmodified legacy Kiln block to the
extended block under the same lock and atomic-write discipline, preserve every byte outside the
marked block, and record that migration in the versioned setup state. If the user removed or changed
the recorded block, do not restore or rewrite it automatically; report the missing runtime ignores
and require an explicit choice. A completed migration is byte-stable on every rerun.

### 3.12 A model quality warning is not a technical compatibility check

Kiln remains provider-agnostic and should not reject a model merely because it is small or absent
from a recommended-model table. It must, however, fail on objective incompatibilities: missing
authentication, an unknown configured model, a provider connection that cannot be established, or a
model/API path that cannot perform the tool calls required by Kiln.

Any preflight that sends a billable inference request must say so and require explicit confirmation.
The default zero-cost preflight checks configuration, auth availability, model resolution, package
loading, and tool signatures. The first interview turn may serve as the live inference/tool-call
test; failure there must produce a diagnostic and must not mutate planning content.

## 4. Target consumer experience

### 4.1 First run

The supported first-run command should be:

```sh
git init
git clone https://github.com/don-milsey-miller/kiln.git .planning

node .planning/bin/setup.mjs \
  --project-root . \
  --name "My Project" \
  --description "What this project is intended to accomplish"
```

The setup command performs all deterministic setup and then starts the combined runtime by default.
It may provide `--no-launch` for provisioning or automation, but a normal interactive first run must
not require the user to discover another command.

Expected visible milestones, with trust resolved before project package installation:

```text
project initialized
dependencies installed
Pi runtime 0.80.6
project trust approved
Kiln Pi package registered for this project
provider: <display name>
model: <exact model id>
browser ready: http://127.0.0.1:<PORT>
starting the Stage 1 interview in Pi
```

These are semantic milestones, not a promise of one log prefix. The current application launcher
emits `[vpw]`; the new setup/supervisor may emit `[kiln]` while teeing the launcher's real output.
Renaming the existing prefix is a separate mechanical change and is not required by this proposal.

Pi then presents one high-value intake question, not a static questionnaire and not a generated
solution.

### 4.2 Subsequent runs

Add a combined-runtime script:

```sh
npm --prefix .planning run kiln
```

It starts the application, resumes the project's recorded Kiln Pi session, rechecks package/model
availability, detects the current stage, and continues from current planning state.

Retain separate commands for diagnosis and development:

```sh
npm --prefix .planning start       # browser only; existing behavior
npm --prefix .planning run agent   # Pi/Kiln orchestrator only
npm --prefix .planning run kiln    # browser + Pi, normal user command
```

The README must label `npm start` as browser-only so it cannot be mistaken for the complete product.

## 5. Target architecture

```text
outer project
├── .planning/                         cloned Kiln tool, ignored
│   ├── bin/
│   │   ├── init-project.mjs           existing content-only initializer
│   │   ├── setup.mjs                  new idempotent installer/configurator
│   │   ├── start-agent.mjs            new Pi launcher
│   │   └── start-kiln.mjs             new two-process supervisor
│   ├── lib/
│   │   ├── pi-runtime.mjs             resolve pinned local Pi and inspect registry
│   │   ├── pi-settings.mjs            locked atomic settings merge
│   │   ├── project-gitignore.mjs       one owner for all Kiln ignore rules
│   │   ├── content-root.mjs            tool, content, and project-root authority
│   │   └── specialists/                existing contract plus runtime additions
│   ├── pi-package/
│   │   ├── package.json                Pi package manifest
│   │   ├── extensions/
│   │   │   ├── index.ts                registration entry point
│   │   │   ├── orchestrator.ts         context, commands, policy
│   │   │   ├── planning-tools.ts       wrappers over existing typed libraries
│   │   │   ├── delegation.ts           isolated child runtime
│   │   │   ├── research.ts             stable research tool adapter
│   │   │   └── validation.ts           stable validation tool adapter
│   │   ├── agents/
│   │   │   ├── research.md
│   │   │   ├── planning.md
│   │   │   └── validation.md
│   │   ├── skills/
│   │   │   └── 01-intake/ ... 09-handoff/SKILL.md
│   │   └── prompts/
│   │       └── kiln-start.md
│   └── package.json                    pins Pi and exposes setup/agent/kiln scripts
├── .pi/
│   ├── settings.json                   package + model defaults; no secrets
│   ├── sessions/                       ignored local Pi transcripts
│   └── runtime/                        ignored local launch/session metadata
└── planning-content/                   committed project truth
```

The package manifest should use Pi's declared package format rather than relying only on directory
conventions:

```json
{
  "name": "@kiln/planning-agent",
  "private": true,
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

`agents/` is intentionally discovered by Kiln's delegation extension relative to the package root;
it is not copied into the consumer's `.pi/agents/` directory and is not a Pi package resource.

## 6. Pi installation, authentication, and model binding

### 6.1 Install and invoke the pinned runtime

Add the chosen exact Pi version to `.planning/package.json` dependencies. Setup installs the locked
dependency graph before invoking Pi. `lib/pi-runtime.mjs` resolves
`node_modules/@earendil-works/pi-coding-agent/dist/cli.js` from the tool root and spawns it with the
current Node executable and `shell: false`.

`setup.mjs` executes before that dependency graph exists. Its static import graph must therefore use
Node built-ins only, exactly like `init-project.mjs`. Validate the running Node version before any
install attempt. After dependencies install successfully, load `pi-runtime.mjs` and all Pi APIs with
dynamic `import()` calls. A top-level import of Pi, Ajv, or any other installed dependency in the
pre-install graph is a test failure.

Every Pi subprocess, including specialists, must derive its invocation from the currently running
Pi executable when possible or from this resolver. Do not rediscover Pi through PATH.

### 6.2 Discover authentication without exposing it

Use Pi's public `AuthStorage` and `ModelRegistry` APIs from the pinned dependency:

1. create the normal user auth storage;
2. load the normal user/custom model registry;
3. call the registry's availability/status methods;
4. present provider display names and model metadata only; and
5. never log credential objects, resolved keys, headers, or environment values.

If no usable model is available, setup explains the supported routes:

- subscription OAuth through Pi's interactive `/login`, including ChatGPT Plus/Pro for OpenAI Codex
  and supported Claude subscription authentication;
- API key saved through Pi `/login` or supplied through the documented provider environment variable;
- a custom/local provider declared through Pi's user `models.json`, including Ollama, LM Studio, or
  vLLM-compatible endpoints; and
- the separately validated local-provider helper where the existing design elects to use it.

For OAuth or saved API-key setup, launch the pinned Pi TUI in an authentication-only step and tell the
user to run `/login` and exit when complete. After it exits, reload `AuthStorage` and `ModelRegistry`;
do not assume authentication succeeded. Local-provider setup must likewise end in a registry entry
that resolves through the pinned Pi instance.

### 6.3 Select and persist the exact model

If setup receives `--provider`, `--model`, or `--thinking`, validate those values against Pi's model
registry. Otherwise, present an interactive selection from authenticated/available models.

Never pick a mutable alias such as "latest" on the user's behalf. Persist the exact IDs returned by
Pi:

```json
{
  "defaultProvider": "<selected-provider-id>",
  "defaultModel": "<selected-model-id>",
  "defaultThinkingLevel": "high",
  "packages": ["<pi-install-produced-local-package-reference>"],
  "skills": ["../planning-content/skills-overrides"],
  "sessionDir": ".pi/sessions"
}
```

Invoke the pinned equivalent of:

```sh
pi install -l ./.planning/pi-package
```

from the outer project root, then inspect the package entry Pi produced. The committed, portable
literal must be `../.planning/pi-package`, using `/` separators and resolving from `.pi/settings.json`
to the exact canonical package directory. If Pi writes an equivalent absolute or Windows-separator
path, the settings merger may normalize only that proven-equivalent package entry. If equivalence
cannot be proven, refuse rather than constructing a different target. Merge the remaining owned
settings only after this validation.

Project settings override global defaults. CLI `--provider`, `--model`, and `--thinking` flags may
override them for one run but must not silently rewrite the project selection.

### 6.4 Provider failure policy

At every launch:

1. resolve the configured provider/model exactly;
2. verify some supported authentication source is configured;
3. verify the package and required tools loaded;
4. report custom-model configuration errors; and
5. refuse to begin or resume work if the selected model is unavailable.

Do not silently fall back to Pi's global default, another provider, another model, or model memory.
Offer a setup rerun or an explicit one-run CLI override.

## 7. Trust and settings policy

Pi packages can execute arbitrary code. Trust is therefore a user decision, not an installer detail.

- Interactive setup must display the canonical outer project path and ask whether to trust Kiln's
  project-local Pi resources.
- Prefer Pi's native interactive trust flow or its public trust API. Do not edit an undocumented JSON
  shape directly.
- An approval is stored in Pi's user trust store. A denial is first-class and aborts agent launch
  without undoing the content scaffold.
- Non-interactive setup refuses unless trust is already recorded or the caller supplied an explicit
  trust option. Never default a CI run to approval.
- Specialist children must not carry a hard-coded `--approve`. They rely on the recorded decision and
  still prove their capability signature before output is accepted.
- Document approval, denial, and revocation, including Pi's `/trust` behavior.

Setup owns only these portions of `.pi/settings.json`:

- the Kiln local package entry;
- the Kiln skill-override path;
- the selected default provider, model, and thinking level; and
- the project-local session directory.

It must preserve all other keys and entries.

## 8. User-facing orchestrator

The orchestrator is the single persistent, user-facing Pi session. Its system behavior must:

1. resolve the canonical sibling `planning-content/` through the existing shared resolver;
2. refuse to operate against `.planning/planning-content/` in a consumer checkout;
3. load and lint the project before proposing work;
4. derive the current stage from definitions and attestations rather than storing a duplicate status;
5. load the matching stage skill;
6. ask one focused question at a time;
7. choose the next question by information value and blocking impact, not by a fixed questionnaire;
8. preserve the user's wording separately from interpretations and proposed solutions;
9. use only registered typed tools for planning-content mutations;
10. delegate bounded research, planning, or validation work when appropriate;
11. verify specialist results before using them;
12. show material proposed changes and request the required user decision;
13. never approve an artifact or attest a user-owned criterion without explicit user authorization;
14. run lint after material mutations and surface findings without paraphrasing them away; and
15. resume from files and attestations even if the conversation transcript is lost.

Register a `/kiln-start` prompt or command. The first launch calls it automatically after the model
and package checks pass. On a new project it begins Stage 1. On an existing project it summarizes the
current stage, unresolved blockers, and the single recommended next action before asking whether to
continue.

The initial Stage 1 turn must not author a solution. It reads the name, description, and starter
document, then asks the highest-value missing question. It updates the intake document continuously,
but stage exit remains blocked until the user explicitly evaluates all four canonical exit criteria.

## 9. Pi tool registration

Create thin TypeBox-validated Pi wrappers around the existing library functions. The extension layer
owns UI/tool schemas and result rendering; business rules remain in `lib/`.

At minimum expose:

- project status/current-stage and lint reads;
- artifact creation through `TYPED_TOOLS`;
- artifact mutation through `MUTATION_TOOLS`;
- project type activation through `PROJECT_TOOLS`;
- stage-attestation write and read operations;
- `research_capability`, `research_search`, and `research_fetch`;
- `validation_capability` and `validation_run`; and
- specialist delegation plus a machine-readable Kiln capability signature.

Do not expose unrestricted filesystem writes or shell execution to the orchestrator merely because
Pi has built-in coding tools. Launch the Kiln session with built-in mutation tools disabled unless a
separate, reviewed requirement justifies one. The intended content write path is the existing locked,
atomic, validated tool layer.

Every wrapper must:

- resolve the content root through `lib/content-root.mjs`;
- validate inputs before mutation;
- return structured success or refusal data;
- avoid leaking credentials and absolute user-home paths;
- preserve existing lock and atomic-write behavior; and
- expose a stable signature that the delegation verifier can compare.

## 10. Stage skills and overrides

Generate one packaged skill for each canonical `stages/*.json` definition. Each skill includes:

- purpose and decision owner from the canonical definition;
- outputs and exit criteria from the canonical definition;
- the stage-specific method;
- rules for selecting the next question or activity;
- allowed delegations and required capabilities;
- mutation and approval boundaries; and
- the expected user-facing completion summary.

Do not hand-maintain stage purpose, outputs, or exit criteria in two places. Implement a generator and
a `--check` mode that fails CI when packaged skills are stale relative to `stages/`.

Register `<project>/planning-content/skills-overrides/` after packaged skills so an override with the
same skill identity wins without modifying the tool clone. Test packaged-only, override-present,
override-edited, and override-removed cases through a real Pi resource load.

## 11. Specialist roster and delegation

Create `research.md`, `planning.md`, and `validation.md` under `pi-package/agents/`. Each file must
declare:

- stable name and description;
- an explicit tool allowlist;
- input contract;
- responsibilities;
- forbidden actions;
- output schema;
- exit criteria; and
- escalation/refusal conditions.

Do not hard-code a model in v1. The delegation extension receives the current orchestrator model and
thinking level and passes them to the exact same pinned Pi executable.

For every child:

1. build a task-scoped context payload, never the full conversation;
2. bind the role system prompt through a private temporary file with restrictive permissions;
3. pass the task as a CLI message or private prompt file;
4. launch with `--mode json -p --no-session`, `shell: false`, and
   `stdio: ["ignore", "pipe", "pipe"]`;
5. pass the exact inherited provider/model/thinking selection;
6. pass an explicit tool allowlist;
7. construct an allowlisted environment containing base runtime values, the selected provider's
   model-plane variables when needed, and only the role's tool-plane credentials;
8. stream progress without treating partial output as accepted output;
9. enforce a bounded timeout and propagate aborts to the process tree;
10. delete temporary prompt material on every exit path;
11. verify the child's Kiln capability signature before reading its substantive answer; and
12. reject output on nonzero exit, timeout, missing task binding, missing capability, signature drift,
    out-of-role writes, malformed JSON events, or model/provider mismatch.

The current `verifyChild()` API must be revised from `stdinDelivered` to the non-contradictory task
binding observation described in section 3.5.

### Role boundaries

Continue deriving role write boundaries and required tool signatures from
`lib/specialists/contract.mjs`; do not duplicate them in the extension. The effective child tool set
must be the intersection of the role's declared allowlist and the measured host registry. Omitting a
`tools:` field is a roster lint error, not permission to inherit Pi's default tools.

Research must refuse to answer from model memory when retrieval is required but unavailable.
Validation must use the validation controller and never receive unrestricted shell access. Only the
planning role may author requirements or decisions, and user-owned approvals remain outside every
specialist's authority.

## 12. Combined runtime and process lifecycle

Implement `bin/start-kiln.mjs` as the lifecycle owner:

1. validate the outer project and project settings;
2. start `bin/start-shell.mjs` with a private stdin pipe and inherited/teed output;
3. read the same `PORT` environment value as `start-shell.mjs` (default `3000`) and wait until that
   loopback health check answers or the launcher exits;
4. start the pinned Pi CLI in the outer project root with terminal stdin/stdout/stderr inherited;
5. on first session, send the unique `/kiln-start` prompt; on later sessions, resume the stored session
   and invoke the resume behavior;
6. if Pi exits, send `stop` and close the application launcher's stdin;
7. on Ctrl+C or termination, stop Pi and the application launcher, wait for both, and escalate after
   bounded grace periods; and
8. remove only runtime files created by that invocation.

Never let the background application process inherit terminal stdin. Never start Pi from inside
`.planning/`; its working directory must be the canonical outer project root.

The self-hosting checkout is a distinct mode because its tool root and project root are the same.
The normal consumer command must refuse that condition rather than writing `.pi/` into the tool
repository by surprise. A contributor may opt in with both an explicit
`PLANNING_CONTENT_DIR=<toolRoot>/planning-content` and `npm run kiln -- --self-host`; the supervisor
verifies those paths agree before starting. Self-host mode is covered separately and never weakens
the consumer-root checks.

Record a stable user-facing session ID in `.pi/runtime/kiln-session.json` and keep session files in
`.pi/sessions/`. The record must contain no credential or absolute home path. If it is missing or
corrupt, recover by presenting available Kiln sessions or create a new one; never resume an unrelated
generic Pi session silently.

## 13. Setup command contract

Implement `bin/setup.mjs` as a composition layer over existing primitives, not a second initializer.

### Inputs

```text
--project-root <path>       required
--name <name>               required non-interactively
--description <text>        optional
--provider <id>             optional exact Pi provider
--model <id>                optional exact Pi model
--thinking <level>          optional
--no-launch                 configure only
--non-interactive           never prompt; refuse on missing decisions
--trust <approve|deny>       optional explicit non-interactive trust decision
```

Do not accept API keys as setup command arguments.

### Ordered steps

1. Resolve and print tool root, outer project root, content root, project settings, and runtime state
   paths before mutation.
2. Validate Node compatibility before attempting to install a dependency graph that cannot run.
3. Call the existing initializer and preserve its current idempotency/refusal semantics.
4. Install the locked `.planning` dependencies if needed, using only the built-ins-only bootstrap
   graph through completion of this step.
5. Dynamically import the pinned Pi integration and verify its exact version.
6. Obtain or verify the explicit project trust decision.
7. Install/register `.planning/pi-package` project-locally.
8. Register `planning-content/skills-overrides/`.
9. Discover available authenticated models without exposing credentials.
10. Perform authentication/local-provider setup if required, then rediscover.
11. Select and persist the exact provider, model, and thinking level.
12. Run the zero-cost model/package/tool preflight.
13. Use the shared `.gitignore` owner to establish or migrate the Kiln block for `.planning/`,
    `.pi/sessions/`, and `.pi/runtime/`; never use a setup-specific appender.
14. Read back and validate all generated/merged state.
15. If launch is enabled, exec or spawn the combined runtime and begin/resume intake.

### Idempotency and failure

- A successful rerun with unchanged choices changes no bytes.
- Existing authored planning content is never overwritten.
- Existing unrelated Pi settings and packages are never removed or reordered gratuitously.
- If setup fails before launch, it prints the last completed phase and an exact recovery command.
- If content initialization succeeded but agent setup failed, report partial setup honestly; do not
  delete valid planning content.
- If trust is denied, the browser may still be started explicitly, but the setup command must not
  describe the agent layer as ready.
- No failure path logs or serializes credentials.

Use distinct exit codes for invalid arguments, content conflicts/damage, missing runtime,
trust denial, provider/model configuration failure, package/capability failure, and launch failure.
Publish the mapping in `--help` and tests.

## 14. Intake behavior acceptance contract

A fresh project is not considered agent-initialized until a real Pi session proves all of the
following:

- Kiln package discovery occurred from the outer project root.
- The canonical sibling `planning-content/` was opened.
- `.planning/planning-content/` was not read as the consumer project and was not modified.
- The configured provider and exact model were selected.
- The Kiln capability signature was present.
- The Stage 1 skill was loaded.
- The first user-facing response asks one relevant question.
- No solution architecture was invented during intake.
- The answer is incorporated into `stages/01-intake.md` through the controlled write path.
- A second question is selected from the updated state, not from a precomputed list.
- The orchestrator refuses to attest or advance Stage 1 without explicit user authorization.
- Restarting the combined command resumes the same project workflow from persisted content and the
  recorded Kiln session.

## 15. Test strategy

### 15.1 Unit tests

Add tests for:

- a built-ins-only static import graph through dependency installation;
- local Pi resolution and version mismatch;
- canonical project-root resolution with and without `PLANNING_CONTENT_DIR`, including mismatch
  refusal against setup's explicit root;
- non-destructive `.pi/settings.json` merge and malformed-file refusal;
- model registry selection, unknown IDs, and unavailable configured models;
- redaction of auth, headers, keys, and home paths;
- model-plane versus tool-plane child environment construction;
- default Windows/POSIX Pi auth-directory resolution through the allowlisted platform variables;
- preservation of a custom `PI_CODING_AGENT_DIR` and custom `XDG_CONFIG_HOME`;
- fresh and legacy `.gitignore` handling, deliberate block edits/removal, migration, and byte-stable
  reruns through the single shared owner;
- task binding with closed stdin;
- provider/model/thinking inheritance;
- exact tool allowlists and capability signature checks;
- timeout, abort, partial JSON, nonzero exit, and cleanup paths;
- stable session selection that cannot resume an unrelated session;
- supervisor shutdown on Windows and POSIX;
- `PORT` propagation into the browser health check; and
- self-host refusal by default and explicit self-host success.

### 15.2 Package integration tests

Run the pinned Pi executable against the real package with a deterministic fake provider/model. Prove:

- `pi install -l` creates a project-local package entry;
- the literal package entry is exactly `../.planning/pi-package`, uses `/` separators, contains no
  absolute/home path, and resolves to the intended package on Windows and POSIX;
- an absolute or separator-locked entry is normalized only after canonical equivalence is proved;
- a wrong-target or unprovable package entry is refused;
- trust approval loads the package and trust denial does not;
- all expected tools, skills, and the start prompt are present;
- packaged skill overrides behave as specified;
- the orchestrator has no unintended built-in mutation tools;
- each specialist has exactly its contract's tools; and
- changing a measured tool signature causes a child refusal.

### 15.3 Clean-consumer end-to-end test

From a temporary empty directory:

1. initialize Git;
2. use a tracked-file-only copy of Kiln as `.planning`;
3. run the documented setup command against a fake, non-billable provider;
4. verify initialization, package registration, trust, model selection, and both processes;
5. drive a deterministic Stage 1 exchange;
6. observe the intake document change through the browser change stream;
7. attempt an unauthorized stage advance and observe refusal;
8. stop the supervisor and prove both child processes, the port, and temporary files are gone; and
9. rerun and prove session/workflow resumption and setup idempotency.

Add negative controls for wrong working directory, missing model auth, environment-only provider auth,
trust denial, corrupt settings, unavailable research, tool signature drift, and a fake child returning
plausible prose without Kiln tools.

Live tests against real paid providers are optional, manually invoked, and never part of default CI.

## 16. Planning-state correction before implementation

Before code is added, reopen Kiln's planning cycle and represent this work in the same structured graph
used for every other deliverable. Reuse existing requirements where they already express the need;
do not create duplicate requirements merely to make the task list larger.

At minimum, the graph must make these components independently visible:

- pinned Pi runtime and runtime resolver;
- setup/auth/model binding;
- Pi package and typed-tool registration;
- user-facing orchestrator;
- stage-skill generation and overrides;
- specialist roster and delegation runtime;
- combined process supervisor; and
- clean-consumer agent-delivery verification.

Each component needs acceptance criteria, tasks, role assignment, trace links to active requirements,
and `implementedBy` links only after code exists. Green stage gates must not be possible merely because
the agent-delivery work was absent from the graph.

## 17. Recommended implementation order

1. **Planning correction and compatibility spike**
   Add the missing graph records. Pin Pi, update Node compatibility, prove package loading and the
   public auth/model registry APIs in a disposable consumer. Measure Pi's default and overridden
   config/auth directory resolution on Windows and POSIX, and record the literal project-local
   package entry written by `pi install -l` before depending on either behavior.

2. **Runtime and settings foundation**
   Build the local Pi resolver, trust integration, atomic settings merge, model discovery/selection,
   credential redaction, and session/runtime directories.

3. **Pi package skeleton and typed tools**
   Add the manifest and register read, mutation, research, validation, attestation, and capability
   tools over the existing libraries.

4. **Stage skills and Stage 1 orchestrator slice**
   Generate the skill set, implement `/kiln-start`, and complete one adaptive Stage 1 conversation
   through a controlled document update and explicit gate refusal.

5. **Specialist definitions and delegation**
   Add all three roles, fix the stdin/task-binding contract, implement model inheritance and credential
   scoping, and enforce capability-signature acceptance.

6. **Setup and combined lifecycle**
   Compose initialization, install, trust, auth/model selection, package registration, browser launch,
   Pi launch, session resumption, and bounded shutdown.

7. **Clean-consumer verification and documentation**
   Add deterministic integration/E2E coverage, update README and setup docs, publish troubleshooting,
   and rerun the full existing suite.

Do not build all nine conversational stages before the Stage 1 vertical slice passes. The first slice
must prove that Pi is truly installed, configured, loaded, conversing, writing through typed paths,
visible in the browser, and unable to cross a user-owned gate.

## 18. Documentation changes required

Update:

- `README.md` with the one-command setup path, separate browser/agent commands, supported auth routes,
  and an explicit pre-1.0 limitation until the E2E test passes;
- `docs/initializing-a-project.md` to distinguish the low-level scaffold command from full setup;
- `docs/running-the-shell.md` to state that `npm start` is browser-only and document the supervisor;
- a new provider/model guide covering `/login`, API keys, custom/local providers, configuration
  locations, model reselection, and credential safety;
- a new trust guide covering approval, denial, revocation, and non-interactive behavior; and
- contributor documentation for updating the pinned Pi version and regenerating stage skills.

Self-host mode also requires this repository's own `.gitignore` to ignore `.pi/sessions/` and
`.pi/runtime/`, with a comment explaining that those paths become live only under explicit
`--self-host`. Do not ignore `.pi/settings.json`: it remains reviewable, non-secret project
configuration. Consumer `.gitignore` changes continue to use the single shared owner specified in
section 3.11; this repository-local rule is a deliberate hand-maintained exception for the tool's
own self-hosting checkout.

Troubleshooting must distinguish at least: Pi missing/version mismatch, project untrusted, package not
loaded, no authenticated models, configured model removed, model inference failed, required tool
missing, research unavailable, validation unavailable, browser port occupied, and retained workspace
cleanup failure.

## 19. Definition of done

The runnable agent-delivery layer is complete only when all of the following are true:

- A fresh consumer needs Git, the supported Node version, and access to a chosen Pi provider; it does
  not need a preinstalled global Pi.
- The documented setup command initializes content, installs the pinned Pi runtime and Kiln package,
  obtains an explicit trust decision, binds an exact authenticated provider/model, and launches the
  complete experience.
- Pi starts in the outer project root and automatically begins or resumes the Kiln workflow.
- The browser and Pi run together under a tested lifecycle owner.
- Stage 1 behaves adaptively, writes through controlled tools, and cannot cross a user-owned gate.
- All three specialists run in isolated Pi children with inherited model selection, scoped context,
  explicit tools, credential separation, closed stdin, timeouts, and capability verification.
- Missing research or validation capabilities produce structured refusals instead of model-memory
  guesses.
- No project file, log, prompt, process argument, tool result, or test fixture contains a real
  credential.
- The clean-consumer E2E test passes on Windows and the project's supported POSIX CI platform.
- The entire pre-existing test suite and plan lint remain green, and new tests cover the agent path.
- The planning graph contains active, traceable records for every agent-delivery component, so future
  completion status cannot be green while this layer is absent.

## 20. Primary implementation references

- `README.md` — current product status and current consumer commands.
- `bin/init-project.mjs` and `docs/initializing-a-project.md` — content-only initializer contract.
- `bin/start-shell.mjs` and `docs/running-the-shell.md` — current browser launcher and shutdown model.
- `lib/specialists/contract.mjs` — role boundaries, credential allowlist, and child verification logic.
- `lib/tools/registry.mjs` — typed creation, mutation, and project-operation registries.
- `lib/research/` and `lib/validation/` — stable capability implementations to wrap for Pi.
- `lib/attestations.mjs` and `stages/` — stage authority and gate evaluation inputs.
- `references/notes-transcriptions/notes.md` decisions 9, 10, 12, 26, 28, 29, 32, 33, 35, 65, 66, 67,
  68, 69, 70, 71, 81, and 124–125 — canonical architectural intent and measured Pi findings.
- Pi package documentation: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>
- Pi settings/trust documentation: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md>
- Pi provider documentation: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md>
- Pi subagent example: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent>
