# Kiln runnable agent-delivery layer

## Updated technical implementation proposal

**Status:** Phase 1 complete — planning graph corrected, compatibility spike executed, design
positions below revised against measurement. Phases 2-7 are not started and await review.
**Audience:** Kiln maintainers and implementing developers
**Last verified against this repository:** 2026-09-02
**Pi version PINNED and measured:** `@earendil-works/pi-coding-agent` 0.84.4 (DEC-0026)

> ⚠️ **Read section 21 before implementing anything below it.** The compatibility spike of
> 2026-09-02 measured this design against the pinned runtime on Windows and Linux. Most of it
> survived; several concrete statements in sections 3-15 did not, and section 21 lists every one
> with the evidence that corrected it. Where section 21 and an earlier section disagree, section 21
> is what was measured.

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

**Resolved 2026-09-02 (DEC-0026).** The pin is `0.84.4`, the version npm publishes as latest, and
`engines.node` is raised from `>=22` to `>=22.19.0` to match what that release declares. Both changes
are applied. The 0.80.6 measurements recorded elsewhere in this repository are historical evidence
and were re-proved against 0.84.4 rather than carried forward; see section 21. Changing the pin again
must be an intentional dependency update that re-runs the compatibility suite.

The launcher must resolve Pi from `.planning/node_modules`, never by executing an unqualified `pi`
from PATH. A global Pi installation may exist, but it is not the Kiln runtime contract.

### 3.3 Authentication and project model selection are different state

Pi authentication is user- or host-scoped. The selected Kiln provider/model is project-scoped.
They must not be conflated:

| State | Location | May contain secrets? | Commit? |
| --- | --- | --- | --- |
| OAuth/API credentials | Pi user auth store, environment, or user `models.json` | Yes | Never |
| Kiln package registration | `<project>/.pi/settings.json` | No | Yes |
| Default provider/model/thinking level | `<project>/.pi/settings.json` | No | Yes (DEC-0028: always committed; there is no local-only mode) |
| Pi trust decision | Pi's user trust store | No secret, but user-specific | Never |
| Session files and local launch state | Selected project-local or external user-local state root | Potentially sensitive | Never |
| Research credential | Host environment or user credential store | Yes | Never |
| Kiln project ID and research-provider choice | `<project>/.pi/kiln.json` | No | Yes |
| Connection inspection/use consent | `<local-state>/runtime/consent.json` | No secret, but user-specific | Never |

The project settings file chooses an exact provider and exact model ID. It must contain no API key,
OAuth token, research key, absolute home path, or copied credential material.

Technical access is not consent. During initial setup, and again when the configured provider or
research choice changes, Kiln must obtain permission before inspecting user- or host-scoped Pi
configuration or even checking whether relevant credential environment variables are present. The
prompt must describe this as checking for existing connections or configuration, not as searching
for credentials. This local inspection reports sanitized availability metadata only and contacts no
external service.

Permission to inspect is separate from permission to use. After inspection, the user must explicitly
select or confirm the exact Pi provider/model and must separately choose whether to validate and
enable Tavily. Detecting one usable model, Pi's global default, a `TAVILY_API_KEY`, or a committed
project research choice does not authorize Kiln to adopt or use it. A saved project selection avoids
repeating the choice on every launch, while the ignored local consent record prevents one user's
approval from becoming another user's approval after clone. A provider/research change, missing local
consent record, or invalidated connection reopens the relevant prompt.

The implementation and documentation must keep these lifecycle states distinct:

| Lifecycle point | Project Pi selection | Existing host Pi setup | Tavily |
| --- | --- | --- | --- |
| After `init-project.mjs` | None; the command is content-only | Unknown and uninspected; it may already exist | Unknown and uninspected; the initializer supplies no key |
| After approved local inspection | Still none until the user confirms a choice | Sanitized available/unavailable metadata only | Presence/absence only; no Tavily request yet |
| After successful agent setup | Exact provider/model saved and verified | The explicitly selected connection may be used | Explicitly enabled after a successful probe, or clearly disabled/unavailable |

A fresh project therefore begins without project-specific Pi/model binding and without a
project-supplied research credential. It must not claim that no host-level configuration exists until
the user permits the check, and successful full agent setup must not end without an explicitly
confirmed, usable Pi provider/model. Tavily remains optional.

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

Add `lib/pi-provider-credentials.mjs` as the single audited provider credential contract. For every
built-in provider supported by the pinned Pi version, it declares the provider ID, supported auth
source categories, and exact required/optional model-plane environment-variable **names**. It never
contains or returns their values. Custom providers may contribute names only through a validated,
declarative user configuration shape; Kiln must not discover a custom contract by enumerating the
host environment or guessing from a provider name. A custom or built-in environment-authenticated
provider with no safe known mapping is `unsupported-credential-contract`, not permission to inherit
more variables.

The effective child environment is the union of the measured base runtime/configuration variables,
the selected provider contract's model-plane names, and the role's tool-plane names. The research
role alone may add `TAVILY_API_KEY`.

⚠️ **Corrected by measurement (AST-0045, EVD-0080).** That union is exact on POSIX and is only a
LOWER BOUND on Windows: the platform injects `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SYSTEMDRIVE`,
`TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE` and `WINDIR` into every child regardless of the
environment supplied, which was isolated with a bare Node child as the control. The provable claim,
and therefore the one the acceptance criteria state, is that **no unrelated secret crosses the
boundary** — demonstrated with sentinel variables against a control that shows them crossing under
inheritance. A second consequence follows: because `USERPROFILE` is always present on Windows, a
child can always resolve the default agent directory, so a child is redirected by setting
`PI_CODING_AGENT_DIR` positively and never by omitting a variable. Before accepting the contract, spawn a disposable restricted Pi
child that resolves the exact provider/model and reports only availability plus the auth-source
category; it must not report variable names, values, headers, or credential-derived fingerprints.
Sentinel tests must prove that unrelated host secrets never cross this boundary. Prefer Pi's user auth
store whenever it is available because then children need configuration-location variables rather
than copied model-plane credentials.

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
the `.planning` clone. In the default project-local mode, store the user-facing session under the
outer project's `.pi/sessions/` and local supervisor state under `.pi/runtime/`, and add those paths
to the outer project's `.gitignore`. Explicit user-local mode relocates both to the external state
root defined in section 13. Do not ignore `.pi/settings.json` or `.pi/kiln.json`, which are
reproducible, non-secret project configuration. This intentionally amends canonical decision #29,
which previously placed session state under `.planning/`. The decision record and its layout diagram
must be updated in the same change so only one answer remains live.

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
loading, and tool signatures. It is necessary but not sufficient: a registry entry cannot prove that
the endpoint answers or that the model will perform Kiln's required tool calls.

Before describing the agent as ready, setup therefore runs one separately approved, bounded live
canary. It sends no planning content, exposes only a read-only setup-only `kiln_preflight` tool, and
requires the model to call that tool with a random challenge and the exact declared schema. The
request uses a low token ceiling, cannot invoke any mutation tool, and is never silently combined with
the first interview turn. The approval prompt names the exact provider/model and plainly states that
the provider may charge for the request. Declining leaves a valid content/browser setup but does not
mark the agent ready or begin intake.

Success is stored only in `<local-state>/runtime/model-compatibility.json`, keyed on **exactly eight
determinants** (`DEC-0033`), nested in a `key` object so comparison is one deep equality and nothing
outside it can become a determinant by accident:

| # | Determinant | Note |
| --- | --- | --- |
| 1 | `provider` | |
| 2 | `model` | The exact id, never a mutable alias |
| 3 | `thinkingLevel` | Changes the request; some providers reject `reasoning_effort` outright |
| 4 | `piVersion` | The runtime builds the request and parses the tool call |
| 5 | `apiType` | `openai-completions` and `anthropic-messages` serialise tool calls differently |
| 6 | `endpointIdentity` + `endpointIdentitySource` | See the normalisation rule below |
| 7 | `effectiveRequestProfile` | Derived from the **resolved model**, not raw `models.json` — the effective `compat` values, `reasoning`, and the resolved `thinkingLevelMap` result |
| 8 | `preflightContractDigest` | See below |

⚠️ **Determinant 8 replaces what this section previously called the "Kiln package capability
signature".** It digests the exact canary protocol as handed to Pi — tool name, description, input
schema, normalised prompt template, and the success predicate with its version — with the random
challenge replaced by a placeholder before hashing, or the digest would differ every run and never
hit. Keying on the whole package signature charged the operator for a new billable check whenever an
unrelated planning tool changed, while the canary runs with **only** the preflight tool exposed, so
its proof was never about the rest of the package. Computing it from the *effective contract* still
catches a change in how Kiln presents the tool.

⚠️ **The package capability signature is retained — as a zero-cost integrity check at every launch**
(section 6.6), where a mismatch means the loaded package is not the one that was installed. It does
not by itself invalidate the paid canary.

⚠️ **Determinant 6 normalises, and never silently strips.** Lowercase scheme and host, explicit port,
and the **pathname preserved** — a path is routing, and two deployments differing only after the host
are two endpoints. A base URL bearing **userinfo or a query is refused outright** rather than
sanitised: stripping a query would let two differently routed endpoints share one proof, and an
identity that is merely "non-secret after normalisation" is not a property a persisted file may rely
on. Such an endpoint needs an explicitly **declared** non-secret identity — recorded as
`endpointIdentitySource`, because a measured identity and an asserted one are different claims about
the same string — or the canary simply re-runs.

Never store a credential value, a credential-derived fingerprint, or a URL containing user
information. Timestamps, paths, session ids and consent state are deliberately **outside** the key:
each would either invalidate the cache every run or tie it to something that cannot change the
model's behaviour. Changing any determinant invalidates the record and reopens approval. A failure
mutates no planning content and records **no result at all** — a stored failure would be a cache of a
refusal — and offers retry, authentication repair, or explicit model reselection. Normal launches may
reuse a matching result while still performing the zero-cost availability checks in section 6.6.

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
Pi runtime 0.84.4
project trust approved
Kiln Pi package registered for this project
existing connections checked with permission
provider: <display name>
model: <exact model id>
live model/tool check passed
web research: Tavily enabled | not connected | disabled
browser ready and verified: http://127.0.0.1:<PORT>
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
│   ├── app/health/kiln/route.js        run-identity readiness endpoint
│   ├── lib/
│   │   ├── pi-runtime.mjs             resolve pinned local Pi and inspect registry
│   │   ├── pi-settings.mjs            locked atomic settings merge
│   │   ├── pi-provider-credentials.mjs audited model-plane credential contracts
│   │   ├── setup-transaction.mjs      one lock, write plan, journal, and recovery
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
│   │   │   ├── model-preflight.ts      setup-only read-only live canary
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
│   ├── kiln.json                       committed Kiln capability choices; no secrets
│   ├── sessions/                       default ignored local Pi transcripts
│   └── runtime/                        default ignored launch/consent/compatibility state
└── planning-content/                   committed project truth
```

The `.pi/sessions/` and `.pi/runtime/` entries show the default project-local state mode. Explicit
external user-local mode relocates both as specified in section 13 without changing committed paths
or writing an absolute home path. `.pi/kiln.json` contains a generated non-secret stable project ID
and Kiln capability choices; it contains no user-specific consent or credential material.

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
dependency graph before invoking Pi. `lib/pi-runtime.mjs` resolves the CLI from the tool root and
spawns it with the current Node executable and `shell: false`.

⚠️ **The path is `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`**, not
`dist/cli.js`. That is what the package's own `bin` field points at in 0.84.4, and it is what every
run in the compatibility spike used. Resolve it from the `bin` field rather than hard-coding either
spelling.

`setup.mjs` executes before that dependency graph exists. Its static import graph must therefore use
Node built-ins only, exactly like `init-project.mjs`. Validate the running Node version before any
install attempt. After dependencies install successfully, load `pi-runtime.mjs` and all Pi APIs with
dynamic `import()` calls. A top-level import of Pi, Ajv, or any other installed dependency in the
pre-install graph is a test failure.

Every Pi subprocess, including specialists, must derive its invocation from the currently running
Pi executable when possible or from this resolver. Do not rediscover Pi through PATH.

The Pi compatibility spike is a hard proof gate, not an implementation convenience. Before later
agent-delivery work may rely on the inspected Pi behavior, a disposable clean-consumer project must
produce recorded, reviewable evidence against the exact pinned Pi version on Windows and the
supported POSIX platform that:

- the local CLI resolves from `.planning/node_modules` and reports the expected exact version;
- project trust can be approved, denied, detected, and revoked through Pi's supported behavior;
- `ModelRuntime` and `ModelRegistry` discover saved **API-key** authentication and custom/local
  models without network access and without exposing credential material — ✅ proved, with a
  no-credential control. **`AuthStorage` is not importable**, and **OAuth is supported but not yet
  verified** — by decision it is verified only by a manual account-bound run, never by a fabricated
  credential (`DEC-0032`, `TSK-0066`);
- the authentication-only Pi TUI can be launched with exclusive terminal ownership, its exit outcome
  can be distinguished from proven authentication, and a non-TTY path can refuse without hanging —
  ⏳ **not proved**; it needs a real terminal and is scheduled as a manually invoked check
  (`TSK-0065`);
- default and overridden Pi configuration directories resolve as expected and remain reachable by a
  restricted specialist child;
- `pi install -l` writes an observed package reference that can be normalized to the portable project
  entry only after canonical equivalence is proved;
- the installed package loads its extensions, tools, skills and prompts — ✅ proved, prompts via a
  packaged template whose expanded body is observed at the provider. **The capability signature is
  not proved**: it belongs to the Kiln package, which does not exist yet (`TSK-0067`);
- project-local and externally supplied session/runtime locations resolve without committing an
  absolute user path — ✅ proved, all three routes;
- a closed-stdin child can receive a bound task through the selected non-interactive mechanism —
  ✅ proved, observed at the provider rather than taken from the model; and
- environment-only model authentication can reach a specialist through the intended provider-scoped
  allowlist without unrelated host variables crossing the boundary — ✅ proved: a `$VAR`-authenticated
  provider is available exactly in the child carrying that variable, with an inline-key provider
  listed in both runs as the isolation control.

Each proof must include a negative control that would fail if the claimed behavior were absent, plus
redaction assertions over command output, logs, errors, and generated state. If the pinned Pi version
does not satisfy any observation, revise the design or select a different exact version before
continuing; do not replace evidence with a version-specific assumption. The compatibility fixtures
become part of the normal test suite so a later Pi update must re-prove the contract.

### 6.2 Discover authentication without exposing it

Before using Pi's user-scoped APIs or checking credential environment-variable presence, setup asks:

```text
Kiln can check this computer for existing AI-provider and optional web-research connections. It will
only report what is available; it will not display or copy API keys, and it will not contact external
services during this check. Check now?
```

Only after approval, use the discovery surface the pinned dependency actually exports. **Settled by
measurement 2026-09-03 (`AST-0051`, `EVD-0084`); this replaces an earlier instruction to use an
`AuthStorage` class, which the package does not publish.**

```js
const runtime  = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
const registry = new ModelRegistry(runtime);
```

1. construct the runtime with `allowModelNetwork: false` — it is the default, and it is what lets
   this step satisfy the rule that a consent-gated inspection contacts no external service;
2. read availability with **`registry.getAvailable()`**, never `getAll()`;
3. take provider display names from `getProviderDisplayName()` and per-model auth from
   `hasConfiguredAuth()`;
4. present provider display names and exact model IDs only; and
5. never log credential objects, resolved keys, headers, or environment values.

⚠️ **`getAll()` RETURNS THE ENTIRE BUILT-IN CATALOGUE — 1291 models on 0.84.4**, across every
provider Pi knows of, authenticated or not. A selection step built on it would offer the operator a
thousand models they cannot use. `getAvailable()` is the one to present.

⚠️ **PROVIDER AUTH STATUS IS NOT AVAILABILITY, and section 6.6 must not gate on it.** With a stored
OAuth credential for a `models.json` provider, `getProviderAuthStatus()` reports
`{configured: true, source: "stored"}` while `hasConfiguredAuth()` is `false` and the model is absent
from `getAvailable()`. A launch check that verifies "some supported authentication source is
configured" therefore reports ready for a project that cannot infer.

⚠️ **`AuthStorage` EXISTS AND IS UNREACHABLE.** It is a real class at `dist/core/auth-storage.js`
with exactly the `list()` metadata call this section wants — but the package's `exports` map
publishes only `.`, `./rpc-entry` and `./client`, so a deep import is blocked. `readStoredCredential`
is exported from the root for a one-off presence read and returns the credential itself, so a caller
must test presence and never retain or log the value.

⚠️ **THE OAUTH ROUTE IS SUPPORTED AND NOT YET VERIFIED** (`DEC-0032`). Kiln supports OAuth through
Pi's public interactive `/login` flow; what has not happened is the run that proves it. That run is
deliberately **manual and account-bound, outside CI**: an isolated Pi configuration directory and a
sanitized environment, `/login` against a real subscription, then a **freshly constructed**
`ModelRuntime` and `ModelRegistry` showing the chosen built-in model in `getAvailable()` and passing
`hasConfiguredAuth()` — and then removal or revocation of the credential as the control, requiring
the model to become unavailable. Only sanitized single-instance evidence is retained.

⚠️ **A FABRICATED OAUTH CREDENTIAL DOES NOT COUNT, in any form.** Writing a canonical-shaped record
into `auth.json` proves that a storage shape round-trips; it says nothing about whether a
subscription authenticates or a token refreshes. The spike wrote exactly such a record and the model
stayed unavailable — a fact about provider composition, not about OAuth. The API-key path is provable
that way precisely because a stored API key IS the whole mechanism; an OAuth token is one artefact of
a live flow.

Until `TSK-0066` passes, this document and every other may describe OAuth as a **supported** Pi
route, and **no acceptance criterion may state it as verified**.

The same approval permits a presence-only check for the known provider variables required by the
selected Pi integration and for `TAVILY_API_KEY`; it never permits enumerating the environment. A
declined check performs none of these reads. Setup may explain manual configuration routes, but it
must remain partially configured and must not describe the agent as ready until the user later permits
verification of a usable model. Browser-only startup remains available explicitly.

If no usable model is available, setup explains the supported routes:

- subscription OAuth through Pi's interactive `/login`, including ChatGPT Plus/Pro for OpenAI Codex
  and supported Claude subscription authentication;
- API key saved through Pi `/login` or supplied through the documented provider environment variable;
- a custom/local provider declared through Pi's user `models.json`, including Ollama, LM Studio, or
  vLLM-compatible endpoints; and
- the separately validated local-provider helper where the existing design elects to use it.

For OAuth or saved API-key setup, launch the pinned Pi TUI in an authentication-only step and tell the
user to run `/login` and exit when complete. After it exits, **rediscover through the supported
surface** — construct a fresh `ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false })`
and a new `ModelRegistry`, then re-read `getAvailable()` and `hasConfiguredAuth()`. Do not assume
authentication succeeded, and do not reload `AuthStorage`: it is not importable, as the discovery
step above records. Local-provider setup must likewise end in a registry entry that resolves through
the pinned Pi instance.

⚠️ **The interactive half of this is not proved** (`TSK-0065`). That the TUI can be launched with
exclusive terminal ownership, that its exit can be told apart from proven authentication, and that a
non-TTY invocation refuses rather than hanging, all need a real terminal and are scheduled as a
manually invoked check. Implement to this text, but do not record it as verified until that runs.

V1 does not install, start, update, monitor, or stop llama.cpp, vLLM, Ollama, LM Studio, model files,
or their supporting hardware/runtime. The project manager owns that local inference service and must
keep its configured endpoint available. Kiln owns only discovery, explicit selection, the scoped
credential/configuration contract, zero-cost status checks, and the approved live canary. Managed
local inference may be designed later and is outside this implementation.

The complete interactive v1 setup path assumes a local terminal with attached stdin/stdout. Before
launching `/login`, setup must check that it has a real TTY. This matters because a pipe, CI job, IDE
background task, or redirected command has nobody who can safely answer prompts; waiting anyway is a
hang, not authentication. OAuth may also open a system browser or bind a callback on the machine that
runs Pi, which is not necessarily the machine where a user is sitting during SSH or remote execution.

If usable authentication is already present, a non-TTY launch may continue through the explicit
non-interactive contract. If authentication is missing and no TTY is available, refuse before
starting the TUI and print two supported recovery routes: run setup from a local interactive terminal,
or configure Pi authentication/environment/custom models on the target host outside Kiln and rerun
with all required non-interactive decisions. Do not promise device-code or remote OAuth behavior
unless the pinned Pi compatibility proof demonstrates it. API keys remain forbidden on setup command
lines.

Authentication is a resumable setup phase. Record only the non-secret phase outcome, give the Pi TUI
exclusive ownership of terminal stdin while it runs, and distinguish cancellation/EOF/nonzero exit
from successful exit. On return, rediscover auth and model status before advancing; never treat
"login UI exited" as "login succeeded." The background browser launcher always receives a private
stdin pipe, so it cannot consume authentication or planning input intended for Pi.

### 6.3 Select and persist the exact model

If setup receives `--provider`, `--model`, or `--thinking`, validate those values against Pi's model
registry after connection-inspection permission is established. Otherwise, present an interactive
selection from authenticated/available models. Even when discovery returns exactly one usable model,
show its provider display name and exact model ID and require confirmation before assigning it to the
project. Detection is not selection: never adopt Pi's global default or the first available model.
The confirmation explains that subsequent intake turns and specialist work will use this model and
may consume billable tokens or provider quota; the project manager owns the selected account, limits,
pricing plan, and charges. Confirming the project selection authorizes that ongoing use, while the
separate live-canary prompt authorizes only its one diagnostic request.

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

The `sessionDir` field above applies to the default project-local state mode. In external user-local
mode it is omitted from committed settings and supplied through the separately proved runtime path
described in section 13.

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
override them for one run but must not silently rewrite the project selection. **There is no
local-only selection mode (DEC-0028):** the selection is non-secret, reproducible configuration and
is always committed. What is never committed is the operator's consent to use this host's
credentials for it, which lives in the ignored local-state root.

Initial setup and configuration changes require confirmation. Normal subsequent launches do not ask
again merely to use the unchanged project selection; they perform the availability checks below. A
different user or machine with no matching local consent record must run setup and confirm before
Kiln uses that host's authentication.

### 6.4 Prove live inference and tool-call compatibility

After exact model confirmation and the zero-cost checks, show:

```text
Live model check

Kiln will send one small diagnostic request to <provider display name> using <exact model id>. The
request contains no project content and cannot change planning files. Your provider may charge for
this request. Run the check now?
```

Approval permits exactly the bounded canary described in section 3.12, not general background use or
a different model. `kiln_preflight` accepts the random challenge and returns a fixed structured
acknowledgement; it has no access to project mutation libraries, research, validation, delegation, or
the shell. Success requires observing the tool call with the correct challenge and schema through the
real pinned Pi/provider path. Model prose claiming support is not evidence.

In non-interactive setup, `--live-model-check approve` is required when no matching local success
record exists; `deny` leaves setup partial. A matching record may be reused only under the exact
invalidation rules in section 3.12. The first real Stage 1 turn begins only after this canary succeeds.

### 6.5 Detect, validate, and enable Tavily with informed consent

Tavily is an optional public-web search service, not the project's LLM provider. Because many users
will not recognize its name or understand why Kiln needs it, setup must explain its purpose, credential
boundary, network activity, and potential credit use in plain English.

The Tavily flow is:

1. After connection-inspection permission, check only whether `TAVILY_API_KEY` is present. Do not read
   it into a loggable result, display any portion of it, contact Tavily, or enable research.
2. If present, ask separately before external validation and enablement:

   ```text
   Optional web research

   Kiln can use Tavily to search public websites while researching your project. An existing Tavily
   connection was found on this computer.

   The key will not be copied into this project or shown to the AI. Would you like Kiln to check the
   connection and enable web research for this project?

   Checking the connection does not perform a search or use search credits. Future searches may count
   against your Tavily plan.
   ```

3. Only after approval, call Tavily's `GET /usage` capability probe. It validates authentication and
   reports quota without performing a search or spending search credits.
4. Persist the non-secret project choice in `.pi/kiln.json` and the host/user-specific approval in
   `<local-state>/runtime/consent.json`. Store no key, token, header, credential-derived fingerprint,
   or resolved credential value in either file. The local consent record must survive normal runtime
   cleanup but is invalidated when the research provider changes.
5. Make the key available only to the research child and only while research is enabled. Planning and
   validation children never receive it.

If no key is present, say:

```text
Web research is not connected

Kiln can continue without it, but it will not be able to search the web. You can connect Tavily now
or enable it later.
```

User-facing results use plain language while preserving distinct machine-readable reasons:

| Internal state | Required user-facing meaning |
| --- | --- |
| `available` | "Web research is ready." Include remaining credits when Tavily reports them. |
| `no-credential` | "No Tavily connection was found." Explain that setup can continue without web search. |
| `authentication-failed` | "Tavily did not accept the existing connection. No changes were made." |
| `quota-exhausted` | "The connection works, but the Tavily account has no search credits remaining." |
| `backend-unreachable` | "Kiln could not reach Tavily. You can retry later." |
| `user-disabled` | "Web research remains disabled for this project." |

Declining inspection, validation, or enablement is not an error and must not block the Pi planning
workflow. Research that requires retrieval returns the corresponding structured unavailable reason
instead of answering from model memory. A committed `.pi/kiln.json` choice alone never authorizes use
of a credential on a different host.

### 6.6 Provider failure policy

At every launch:

1. resolve the configured provider/model exactly;
2. verify some supported authentication source is configured;
3. verify the package and required tools loaded;
4. verify a matching live model/tool compatibility record exists;
5. report custom-model and provider credential-contract errors; and
6. refuse to begin or resume work if the selected model is unavailable.

Do not silently fall back to Pi's global default, another provider, another model, or model memory.
Offer a setup rerun or an explicit one-run CLI override.

## 7. Trust and settings policy

Pi packages can execute arbitrary code. Trust is therefore a user decision, not an installer detail.

- Interactive setup must display the canonical outer project path and ask whether to trust Kiln's
  project-local Pi resources.
- Use Pi's public trust API. **Measured 2026-09-02 (AST-0041, EVD-0077, EVD-0078):** 0.84.4 exports
  `ProjectTrustStore` from the package root with a typed declaration — `constructor(agentDir)`,
  `get(cwd)`, `getEntry(cwd)`, `set(cwd, decision)`, `setMany(updates)` — plus
  `getProjectTrustOptions`, `getProjectTrustParentPath` and `hasTrustRequiringProjectResources`. A
  grant through `set(cwd, true)` loads project resources in a later non-interactive child with no
  `--approve`; `set(cwd, false)` prevents loading; `set(cwd, null)` reverts. Kiln therefore never
  edits `trust.json` by hand, and `--trust approve` is implementable. **This supersedes the
  mechanism half of canonical decision #67(a); its detection half, #67(b), is untouched and still
  owed.**
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
- the project-local session directory when project-local state is selected.

It must preserve all other keys and entries.

Kiln owns the versioned `.pi/kiln.json` schema, limited to the generated stable project ID and
non-secret Kiln capability choices such as the selected research provider. The project ID is created
once and is not regenerated on a rerun; a missing or conflicting ID is a recovery decision because it
also keys health identity and optional external user-local state. User/host consent, setup journals,
session selection, and live model compatibility results remain under the selected ignored local-state
root and are never committed.

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

Register the `kiln_preflight` canary separately from the normal orchestrator registry. It exists only
for setup's live compatibility request, accepts only the one-time challenge schema, returns a fixed
acknowledgement, and has no reference to content, mutation, research, validation, delegation, or shell
capabilities. Remove it from the effective tool set before the user-facing session starts.

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
2. parse the shared `PORT` value (default `3000`) and refuse values outside the integer range
   `1..65535`;
3. test an exclusive bind on `127.0.0.1` before launch. If the default is occupied, interactive mode
   finds another available port and asks before using it for that invocation; non-interactive mode
   refuses with a shell-appropriate exact `PORT=<n>` recovery command;
4. generate a random run ID and load the non-secret stable Kiln project ID from `.pi/kiln.json`;
5. start `bin/start-shell.mjs` with a private stdin pipe, inherited/teed output, the chosen port, the
   run ID, and the project ID;
6. poll the Kiln-specific loopback health endpoint until it returns the expected service/protocol
   identity, exact run ID, exact project ID, and build version while the expected child remains alive;
7. start the pinned Pi CLI in the outer project root with terminal stdin/stdout/stderr inherited;
8. on first session, send the unique `/kiln-start` prompt; on later sessions, resume the stored session
   and invoke the resume behavior;
9. if Pi exits, send `stop` and close the application launcher's stdin;
10. on Ctrl+C or termination, stop Pi and the application launcher, wait for both, and escalate after
   bounded grace periods; and
11. remove only runtime files created by that invocation.

The health route returns JSON containing only `service: "kiln"`, a versioned health protocol, the
ephemeral run ID, the non-secret project ID, and the build version. It never returns an absolute path,
credential, session content, or planning content. An HTTP response from `/`, a response with a wrong
run/project ID, or a response from a process other than the expected child is not readiness. This is
the negative control the current generic HTTP probe lacks: an unrelated service already listening on
port 3000 must make launch refuse rather than report Kiln ready.

The temporary bind check narrows the port-conflict race but does not establish identity; only the
run-specific health handshake does that. On bind failure, child exit, identity mismatch, or readiness
timeout, stop every process started by the invocation, preserve diagnostic output, and print the exact
retry command. Never silently attach to an existing server or silently persist an automatically chosen
port as project configuration.

Never let the background application process inherit terminal stdin. **That is two hops, and each
owns its own.** The supervisor gives the launcher a private pipe rather than the terminal; the
launcher in turn gives the application *no* stdin at all, rather than passing on whatever it was
handed. The second hop is not implied by the first: a launcher that inherits its stdio hands the
application the very pipe its own stop control arrives on, so a second reader on that handle steals
bytes from the reader meant to have them — standalone, it hands over the terminal directly. The
application needs no stdin, so it is given none, which makes the guarantee structural rather than a
question of who reads first.

The launcher validates the run identifier, project identifier and port before using any of them, and
propagates the identity it validated rather than whatever the environment held. A partial, malformed
or **present-but-empty** identity is a refusal, before install and before build: starting anyway
produces a shell the supervisor can never recognise, surfacing to the operator as a readiness timeout
two processes away from its cause. The refusal names the offending variable and never its value.

**An empty value is a set value, and the distinction is load-bearing in both places it appears.**
Standalone means the identity variables are absent, not blank; an empty `PORT` is refused rather than
read as unset. Both defaults are safe only for the case where nobody chose — a supervisor whose port
or identity computation produced nothing would otherwise start a shell on a port it did not pick, or
under no identity at all, and then poll for what it believed it had asked for.

The launcher stops both on the stop control message and on its stdin closing — a supervisor that dies
cannot send a message, but the operating system closes its pipes regardless. That EOF behaviour
applies to any piped stdin, supervised or not; only interactive standalone operation is unchanged.

Never start Pi from inside
`.planning/`; its working directory must be the canonical outer project root.

The self-hosting checkout is a distinct mode because its tool root and project root are the same.
The normal consumer command must refuse that condition rather than writing `.pi/` into the tool
repository by surprise. A contributor may opt in with both an explicit
`PLANNING_CONTENT_DIR=<toolRoot>/planning-content` and `npm run kiln -- --self-host`; the supervisor
verifies those paths agree before starting. Self-host mode is covered separately and never weakens
the consumer-root checks.

Record a stable user-facing session ID in `<local-state>/runtime/kiln-session.json` and keep session
files under `<local-state>/sessions/`. The record must contain no credential or absolute home path. If
it is missing or corrupt, recover by presenting available Kiln sessions or create a new one; never
resume an unrelated generic Pi session silently.

## 13. Setup command contract

Implement `bin/setup.mjs` as a composition layer over existing primitives, not a second initializer.

### Filesystem and settings transaction

Setup has one project-wide transaction owner in `lib/setup-transaction.mjs`. It reuses the existing
canonical `<project>/.planning-init.lock`; the initializer and `.gitignore` helper must accept the
already-held transaction rather than acquire competing nested locks.

**The transaction is an authenticated capability with a lifetime, not an object with a shape.** A
collaborator that runs inside a held transaction — the initializer, the ignore owner — must
establish that the transaction module *issued* the object it was handed and that the object is
*still live*, because neither fact is visible in its structure. Reading `plan.projectRoot` and
believing it accepts an object literal as proof the lock is held. The transaction is therefore
tracked in a private `WeakMap` carrying its project and an active flag; it is revoked before the
lock is released; and every operation through a revoked transaction is refused.

Authenticating a collaborator at the door is not the same as having it inside: work runs within a
transaction only by being *registered* with it, through the transaction-owned primitive that
re-authenticates and enrols in one step. Registered work is drained to quiescence before revocation
— repeatedly, until the registry is empty, because an operation being drained can start another —
and if any work was still running when the body returned, it completes under the lock and the run is
reported failed, that being the one route by which a write could outlive the lock without meeting a
revocation check. Nothing is claimed about operations the body did not await that had already
settled: they are indistinguishable from awaited ones and could not have crossed the boundary.
Correspondingly, the nesting guard records *leases* rather than names: an async context created
inside a lock keeps that context permanently, so a guard that recorded ancestry refused legitimate
acquisitions from such a context long after the lock was gone.

**The lock is acquired before the plan is built, not after.** Planning is not a read-only survey: it
probes each parent by creating and renaming a real file, so two unlocked planners create and delete
the same directories concurrently. Planning therefore refuses unless the calling process
demonstrably owns the lockfile. Holding the lock, and before the first lasting write, the
transaction owner:

1. canonicalizes and prints every tool, project, content, settings, session, runtime, and temporary
   target, and proves each one resolves beneath a root the caller **explicitly authorized** —
   `project` always, `state` only when a state root was passed. The proof resolves through the
   deepest existing ancestor and compares canonical prefixes, because `relative()` and `resolve()`
   compare the spelling of a path and a junction is not a spelling. A relative path that reads as
   `.pi/settings.json` and resolves outside the project is a refusal, as is the lock file itself.
   **Each target's plan key is derived from the resolved path**, because a canonical location is not
   a canonical identity: `.pi/settings.json` and `.pi/a/../settings.json` are one file, and two
   entries for one file are two recorded identities whose second write is compared against a digest
   taken before the first. The plan is additionally indexed by physical location, which is the only
   thing that catches the overlapping-roots case — project-local state lives at `<project>/.pi`, so
   `project:.pi/runtime/x.json` and `state:runtime/x.json` name one file with keys sharing no
   characters;
2. parses and schema-validates every existing Kiln/Pi file it may read or merge, including setup and
   consent schema versions;
3. rejects the tool/content root relationships already forbidden by the shared resolver, using that
   resolver's canonicalization rather than a second implementation of it;
4. probes same-directory temporary-file creation and atomic rename in each parent it will mutate,
   then restores the directory to what it found — every probe file **and every directory created in
   order to probe**, removed on every exit path, with `rmdir` so a directory something else
   populated survives. A plan that refuses must leave the project unchanged; one that creates `.pi/`
   and then refuses has still changed it. A removal that cannot be completed is a refusal naming
   every path left behind, retaining alongside it whatever refusal caused the attempt — never a
   silent success, since a suppressed cleanup error is exactly a plan reporting that it changed
   nothing while a probe file remains. Absence is confirmed by observing the path rather than by
   trusting the removal call: measured on Windows, `rmdir` against a file throws `ENOENT` and leaves
   the file in place;
5. records hashes of every existing file it may merge; and
6. constructs the complete owned-field/write plan before applying it.

Under the lock, re-read and compare those hashes immediately before each merge, and re-prove the
target still resolves where the plan said it did — a junction can appear after planning as easily as
an edit can. A concurrent edit is
a refusal/retry, not a stale write. Use same-directory temporary files and atomic replacement for
settings and records; append `.gitignore` only through its existing re-read-under-lock owner. Merge
only Kiln-owned fields, preserve unrelated settings and authored planning content, and refuse malformed
or unknown schema versions. There is no general `--force`.

After the initializer establishes safe local-state handling, maintain a non-secret
`setup-transaction.json` journal in the selected runtime directory. **It is a planned target like any
other** — canonicalized, contained under an authorized root and probed at plan time, never a path
handed to a writer at write time; the one file written on the failure path must not be the one file
that skipped every check. Only *when* the first record lands is deferred to the coverage decision.
It records the planned operation,
last completed phase, file identities rather than credential/config values, and recovery status.
Each identity names the root it is relative to, since with `--local-state user` the two roots are not
nested. On
success remove it, and report a removal that fails for any reason other than the file already being
absent: the journal's presence is the interruption signal, so a run that reports success while
leaving one behind has published a false account of its own state. On interruption or later failure
retain it and print an exact resume/recovery
command. Never roll back or delete a valid planning scaffold merely because a later agent phase failed.

Project-local state is the default and requires the exact Kiln `.gitignore` coverage for
`.pi/sessions/` and `.pi/runtime/` before either directory receives data. If that block is missing or
was deliberately edited, interactive setup offers only safe choices: approve the exact marked block,
use external user-local state, or stop before agent launch. Non-interactive setup refuses unless the
chosen policy is already satisfied. It must never proceed with transcripts, consent, or compatibility
records exposed to normal Git tracking.

External user-local state is selected explicitly with `--local-state user` and is stored beneath
`%LOCALAPPDATA%\Kiln\projects\<project-id>\` on Windows or
`${XDG_STATE_HOME:-$HOME/.local/state}/kiln/projects/<project-id>/` on POSIX. The committed non-secret
project ID supplies the stable key; no absolute user path is committed. In this mode omit the
project-local `sessionDir` setting and pass the external session location through `--session-dir`.

⚠️ **Proved 2026-09-02 (AST-0047, EVD-0081).** Three routes relocate session storage on 0.84.4, in
the documented precedence order `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then the
`sessionDir` setting; all three were exercised on Windows and Linux. Because the first two are
supplied by the supervisor at launch, the external mode needs no absolute user path in committed
configuration. The conditional that would have withdrawn this mode is discharged.

### Inputs

```text
--project-root <path>       required
--name <name>               required non-interactively
--description <text>        optional
--provider <id>             optional exact Pi provider
--model <id>                optional exact Pi model
--thinking <level>          optional
--inspect-connections <approve|deny>
                              optional explicit non-interactive permission to inspect user/host setup
--research <tavily|disabled>
                              optional explicit research choice; tavily permits its zero-cost probe
--live-model-check <approve|deny>
                              explicit non-interactive consent for a potentially billable canary
--local-state <project|user>  project-local ignored state (default) or external user-local state
--no-launch                 configure only
--non-interactive           never prompt; refuse on missing decisions
--trust <approve|deny>       optional explicit non-interactive trust decision
```

Do not accept API keys as setup command arguments. `--provider`/`--model` select a desired model but
do not implicitly grant permission to inspect user/host configuration. `--research tavily` is an
explicit non-interactive request to validate the detected Tavily connection through `GET /usage` and
enable it; it is not a way to provide a key. `--live-model-check approve` authorizes only the bounded
canary against the explicitly selected provider/model.

### Ordered steps

1. Resolve and print tool root, outer project root, content root, project settings, and runtime state
   paths before mutation.
2. Validate Node compatibility before attempting to install a dependency graph that cannot run.
3. Acquire the single project setup lock, validate existing schemas/paths/write capabilities, record
   existing-file identities, and build the complete transaction plan.
4. Call the existing initializer under that transaction and preserve its current
   idempotency/refusal semantics.
5. Create or verify the stable non-secret project ID, then establish the approved project-local ignore
   block or validated external user-local state before writing any session, consent, compatibility,
   or transaction record.
6. Create/resume the non-secret transaction journal in the selected runtime directory.
7. Install the locked `.planning` dependencies if needed, using only the built-ins-only bootstrap
   graph through completion of this step.
8. Dynamically import the pinned Pi integration and verify its exact version.
9. Obtain or verify the explicit project trust decision.
10. Install/register `.planning/pi-package` project-locally.
11. Register `planning-content/skills-overrides/`.
12. Obtain or verify explicit permission to inspect existing user/host connections. Before approval,
   do not read Pi's user auth/custom-model registry or check credential-variable presence.
13. Discover available authenticated models and the presence-only Tavily state without exposing
    credentials or contacting external services.
14. Perform authentication/local-provider setup if required, then rediscover under the same approved
    scope.
15. Present sanitized results and obtain explicit selection or confirmation of the exact provider,
    model, and thinking level before persisting them.
16. Resolve the selected provider credential contract and prove it through a disposable restricted
    child; refuse an unknown/unsafe environment-only mapping.
17. Obtain a separate Tavily validation/enablement choice. If approved, run `GET /usage`, report the
    plain-English outcome, and persist only non-secret project choice and local consent state. If it is
    absent or declined, continue with web research unavailable.
18. Run the zero-cost model/package/tool preflight.
19. Obtain explicit consent for and run the bounded live model/tool canary unless an exact matching
    local success record exists. Decline or failure leaves the agent not ready and does not begin
    intake.
20. Read back and validate all generated/merged state, mark the transaction complete, and remove the
    completed journal.
21. If launch is enabled, exec or spawn the combined runtime, prove browser identity/readiness, and
    begin/resume intake.

### Idempotency and failure

- A successful rerun with unchanged choices changes no bytes.
- Existing authored planning content is never overwritten.
- Existing unrelated Pi settings and packages are never removed or reordered gratuitously.
- Existing files are re-read under the setup lock before merge; a changed identity refuses rather
  than overwriting an edit that arrived after planning.
- Unchanged, valid project selections and matching local consent records are reused without prompting
  on every launch; a provider/research change or missing local record reopens the relevant prompt.
- A matching live compatibility record is reused byte-stably; changing provider, model, thinking
  level, endpoint identity, Pi version, or package capability signature invalidates it.
- If setup fails before launch, it prints the last completed phase and an exact recovery command.
- If content initialization succeeded but agent setup failed, report partial setup honestly; do not
  delete valid planning content.
- If trust is denied, the browser may still be started explicitly, but the setup command must not
  describe the agent layer as ready.
- No failure path logs or serializes credentials.

Use distinct exit codes for invalid arguments, content conflicts/damage, filesystem/settings/storage
refusal, missing runtime, trust denial, interactive authentication required, provider/model or
credential-contract failure, live compatibility refusal/failure, package/capability failure, and
browser/Pi launch failure. Publish the mapping in `--help` and tests.

## 14. Intake behavior acceptance contract

A fresh project is not considered agent-initialized until a real Pi session proves all of the
following:

- Kiln package discovery occurred from the outer project root.
- The canonical sibling `planning-content/` was opened.
- `.planning/planning-content/` was not read as the consumer project and was not modified.
- User/host connection configuration was not inspected before explicit permission.
- The configured provider and exact model were explicitly selected or confirmed rather than inferred
  from Pi's global default or discovery order.
- The selected environment-only provider, if any, had a proved scoped credential contract; no
  unrelated host variable reached the orchestrator or a specialist child.
- The user approved the potentially billable live check, and the exact provider/model invoked the
  setup-only `kiln_preflight` tool with the expected challenge without receiving or mutating planning
  content.
- Tavily inspection, external validation, and enablement followed their separate consent boundaries;
  declining Tavily did not block the planning workflow.
- Session, consent, compatibility, and transaction state was either covered by the exact project
  ignore policy or placed in the validated external user-local state root.
- The browser health response matched the current run ID and project ID; an unrelated listener could
  not satisfy readiness.
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
- TTY detection before `/login`, non-TTY refusal when auth is missing, preconfigured non-interactive
  success, cancellation/EOF/nonzero auth exits, and rediscovery rather than assumed login success;
- no Pi user-auth/custom-model read or credential-variable presence check before inspection consent;
- inspection refusal, including proof that it performs no user/host configuration reads and leaves
  setup honestly partial rather than claiming the agent is ready;
- a single discovered Pi model still requires explicit confirmation, and Pi's global default or the
  first discovered model is never adopted implicitly;
- unchanged selections reuse matching local consent while provider/research changes and missing local
  consent reopen the relevant prompt;
- Tavily presence detection performs no network request, credential serialization, or enablement;
- Tavily's `GET /usage` probe runs only after separate approval, and declining it still permits setup
  and browser/agent operation with research unavailable;
- the plain-English Tavily outcomes map exactly to `available`, `no-credential`,
  `authentication-failed`, `quota-exhausted`, `backend-unreachable`, and `user-disabled`;
- `.pi/kiln.json` and `<local-state>/runtime/consent.json` contain no credential material, and a
  committed research choice without matching local consent cannot authorize another host's
  credential;
- built-in provider credential mappings, validated custom-provider variable-name declarations,
  `unsupported-credential-contract`, and sentinel proof that unrelated environment variables never
  reach a child;
- live canary approval/denial, exact challenge/schema verification, strict token/tool limits, zero
  planning-content access or mutation, diagnostic failure, and every compatibility-record
  invalidation input;
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
- invalid/out-of-range `PORT`, occupied-port interactive choice and non-interactive refusal, exact
  `PORT` propagation, run/project health identity, child-liveness checks, readiness timeout, and an
  unrelated HTTP server that must not satisfy readiness;
- one project-wide lock, preflight schema/path/write/atomic-rename checks, compare-before-merge,
  concurrent edits, read-only and locked files, unknown schema versions, symlink/path aliases,
  interrupted transaction recovery, and byte-stable successful reruns;
- project-local state refusal when ignore coverage is absent, external user-local path derivation on
  Windows/POSIX, no committed absolute path, and separation of two projects' external state; and
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
- `kiln_preflight` is available only to the setup canary and absent from the user-facing orchestrator
  and every specialist;
- packaged skill overrides behave as specified;
- the orchestrator has no unintended built-in mutation tools;
- each specialist has exactly its contract's tools; and
- changing a measured tool signature causes a child refusal.

### 15.3 Clean-consumer end-to-end test

From a temporary empty directory:

1. initialize Git;
2. use a tracked-file-only copy of Kiln as `.planning`;
3. run the documented setup command against a fake, non-billable provider, explicitly approving
   connection inspection, confirming the exact fake model, and approving the live canary;
4. verify initialization, package registration, trust, consent boundaries, model selection, optional
   research choice, scoped child credentials, the canary record, Kiln-specific browser identity, and
   both processes;
5. drive a deterministic Stage 1 exchange;
6. observe the intake document change through the browser change stream;
7. attempt an unauthorized stage advance and observe refusal;
8. stop the supervisor and prove both child processes, the port, and temporary files are gone; and
9. rerun and prove session/workflow resumption and setup idempotency.

Add negative controls for wrong working directory, inspection denied, attempted configuration reads
before consent, implicit adoption of a sole/global-default model, missing model auth,
unknown or overbroad environment-only provider auth, TTY-less login, live-check denial and malformed
canary tool calls, Tavily network access before approval, committed research choice without local
consent, trust denial, corrupt settings, unsafe local-state tracking, interrupted transactions,
occupied ports, an unrelated healthy HTTP service, unavailable research, tool signature drift, and a
fake child returning plausible prose without Kiln tools.

Live tests against real paid providers are optional, manually invoked, and never part of default CI.

## 16. Planning-state correction before implementation

Before code is added, reopen Kiln's planning cycle and represent this work in the same structured graph
used for every other deliverable. Reuse existing requirements where they already express the need;
do not create duplicate requirements merely to make the task list larger.

At minimum, the graph must make these components independently visible:

- pinned Pi runtime and runtime resolver;
- setup transaction, storage policy, auth/model binding, and provider credential contracts;
- live model/tool compatibility canary;
- Pi package and typed-tool registration;
- user-facing orchestrator;
- stage-skill generation and overrides;
- specialist roster and delegation runtime;
- combined process supervisor and run-specific browser readiness; and
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
   Build the local Pi resolver, trust integration, project-wide setup transaction, atomic settings
   merge, project/external local-state policy, model discovery/selection, provider credential
   contracts, credential redaction, and session/runtime directories.

3. **Pi package skeleton and typed tools**
   Add the manifest and register the setup-only preflight plus read, mutation, research, validation,
   attestation, and capability tools over the existing libraries.

4. **Stage skills and Stage 1 orchestrator slice**
   Generate the skill set, implement `/kiln-start`, and complete one adaptive Stage 1 conversation
   through a controlled document update and explicit gate refusal.

5. **Specialist definitions and delegation**
   Add all three roles, fix the stdin/task-binding contract, implement model inheritance and credential
   scoping, and enforce capability-signature acceptance.

6. **Setup and combined lifecycle**
   Compose initialization, install, trust, TTY-aware auth/model selection, live model canary, package
   registration, port selection, run-specific browser health, Pi launch, session resumption, and
   bounded shutdown.

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
  locations, consent before inspecting existing connections, explicit model confirmation, model
  reselection, TTY/headless limitations and recovery, environment-only credential contracts, the
  potentially billable live canary, and credential safety;
- a new optional web-research guide that explains Tavily in plain English, distinguishes local
  detection from external validation and use, documents search-credit behavior and all unavailable
  outcomes, and shows how to enable or disable it later;
- a new trust guide covering approval, denial, revocation, and non-interactive behavior;
- a new setup-recovery guide covering project/external local state, filesystem/settings refusals,
  interrupted transaction journals, occupied ports, and exact resume commands; and
- contributor documentation for updating the pinned Pi version and regenerating stage skills.

Self-host mode also requires this repository's own `.gitignore` to ignore `.pi/sessions/` and
`.pi/runtime/`, with a comment explaining that those paths become live only under explicit
`--self-host`. Do not ignore `.pi/settings.json` or `.pi/kiln.json`: both remain reviewable, non-secret
project configuration. Consumer `.gitignore` changes continue to use the single shared owner
specified in section 3.11; this repository-local rule is a deliberate hand-maintained exception for
the tool's own self-hosting checkout.

Troubleshooting must distinguish at least: Pi missing/version mismatch, project untrusted, package not
loaded, authentication requiring an interactive terminal, no authenticated models, configured model
removed, unsupported provider credential contract, live canary declined/failed, model inference
failed, required tool missing, unsafe/unwritable local state, interrupted setup transaction, research
unavailable, validation unavailable, invalid/occupied browser port, browser health identity mismatch,
and retained workspace cleanup failure.

## 19. Definition of done

The runnable agent-delivery layer is complete only when all of the following are true:

- A fresh consumer needs Git, the supported Node version, and access to a chosen Pi provider; it does
  not need a preinstalled global Pi.
- Local inference engines remain project-manager-operated in v1; Kiln validates their configured Pi
  path but does not claim to provision or manage the service.
- The documented setup command initializes content, installs the pinned Pi runtime and Kiln package,
  obtains an explicit trust decision, binds an exact authenticated provider/model, and launches the
  complete experience.
- Setup obtains permission before inspecting user/host Pi or Tavily configuration, never treats
  detection as consent, and requires explicit confirmation before adopting a provider/model or
  validating and enabling Tavily.
- Environment-only provider credentials cross into Pi children only through an audited provider
  contract, and an unknown mapping is a refusal rather than broader environment inheritance.
- A separately approved, bounded live canary proves real inference and the required tool-call path
  without project content or mutation before the agent is described as ready.
- Tavily setup and failure states are explained in plain English; declining or lacking Tavily leaves
  planning usable with structured research refusals and no model-memory substitution.
- Pi starts in the outer project root and automatically begins or resumes the Kiln workflow.
- The browser and Pi run together under a tested lifecycle owner, and only a matching run/project
  health identity can declare the browser ready.
- Every setup mutation is covered by one project lock, schema-aware write plan, atomic replacement or
  safe append, transaction recovery record, and an ignored project-local or external user-local state
  policy.
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

## 21. Phase 1 outcome — what the compatibility spike changed

Phase 1 ran on 2026-09-02: the planning graph was corrected, the runtime was pinned, and the
compatibility spike was executed against `@earendil-works/pi-coding-agent` 0.84.4 on Windows 11
(Node 24.18.0) and Ubuntu 24.04 under WSL2 (Node 24.11.0). Inference throughout was a local
deterministic OpenAI-compatible fake provider on loopback; no paid provider was contacted and the
operator's own `~/.pi/agent` was never read or written — every run was isolated with
`PI_CODING_AGENT_DIR`.

Every claim below has a negative control that would fail if the claimed behaviour were absent, and
every "did not happen" has a control showing it happening under other conditions. Both rules come
from this project's own spike discipline of 2026-08-18: take the mechanical observable upstream of
the model, and prove the observation point was reached before believing an absence.

### 21.1 Design positions that survived

- **Trust must be granted or nothing loads.** An untrusted `--mode json -p` child on 0.84.4 loads no
  package, therefore none of Kiln's typed tools, and **does not error** — a well-formed session
  completes and the model answers in prose. Reproduced on both platforms, once with a failing model
  and once with a working one, so this is not a symptom of a failed run (`AST-0042`).
- **The default active tool set still includes `bash`, `edit` and `write`.** Unchanged from 0.80.6.
  `grep`, `find`, `ls` and `powershell` are configured but inactive, so "active tools" is still not
  "all configured tools". An explicit `--tools` list narrows the set exactly, and an excluded tool is
  not even offered to the model (`AST-0046`). Section 9's requirement to disable the built-in
  mutation tools is both necessary and achievable.
- **Skill overrides work as designed.** A settings `skills` entry pointing at the consumer's override
  directory wins over a packaged skill of the same identity, and removing the override restores the
  packaged file — provenance read from the loaded file path, not from model behaviour (`EVD-0081`).
- **A closed-stdin child receives its task.** `stdio: ["ignore", ...]` with the task as the `-p`
  argument delivered the exact task text, observed in the user message at the provider boundary
  (`AST-0048`).
- **The live canary is buildable exactly as specified.** A provider-issued tool call reached a
  package-registered tool with its challenge argument intact, with two controls: a prose reply
  produced no execution, and excluding the tool from the allowlist produced neither an offer nor an
  execution (`AST-0049`).

### 21.2 Corrections Phase 2 must apply

| # | What this document said | What 0.84.4 does | Consequence |
| --- | --- | --- | --- |
| 1 | CLI at `dist/cli.js` | `dist/bundle/cli.js`, per the package's own `bin` field | Resolve from `bin`, never a hard-coded spelling |
| 2 | Use the public `AuthStorage` API | It exists at `dist/core/auth-storage.js` and the `exports` map does not publish it. The supported surface is `ModelRuntime.create({allowModelNetwork:false})` + `ModelRegistry`, plus root-exported `readStoredCredential` | **Settled in section 6.2, not deferred.** Present `getAvailable()`, never `getAll()` (1291 models) |
| 3 | Prefer a public trust API; do not edit JSON | `ProjectTrustStore` **is** that API, and is causal across grant, explicit denial and revocation | `--trust approve` ships; decision #67(a)'s mechanism is withdrawn |
| 4 | The child environment **is** the union of base, model-plane and tool-plane names | Exact on POSIX. On Windows a Node-spawned child receives nine home/user names it was never passed | The criterion becomes "no unrelated secret crosses"; a child is redirected by setting `PI_CODING_AGENT_DIR`, never by omitting a variable. ⚠️ The retained control is a bare-Node child: it excludes Pi, but does **not** separate the OS from Node/libuv, so `AST-0045` claims the observable and not the attribution |
| 5 | Normalise the package entry only after proving equivalence | The entry is relative on both platforms and differs **only** by separator | Normalisation is a separator rewrite and the proof is a two-path resolve |
| 6 | External state depends on an unproven Pi capability | Three relocation routes exist, precedence `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` | The external mode ships; the supervisor supplies `--session-dir` so no absolute path is committed |
| 7 | (unstated) | A registered tool's handler is `execute(toolCallId, params, signal, onUpdate, ctx)` | Section 9's wrappers must take **params as the second argument**; reading the first yields the call id and a tool that appears to be called with nothing |
| 8 | (unstated) | `ctx.getSystemPromptOptions()` is an **ExtensionCommandContext** method and is unavailable at `session_start`; loaded-skill provenance is only visible at `before_agent_start`, i.e. after a model turn begins | The capability signature and active-tool check must use `pi.getAllTools()` / `pi.getActiveTools()`, which **are** available at load time. A verifier that waits for `before_agent_start` cannot refuse a child before it starts inferring |

| 9 | (unstated) | `getProviderAuthStatus()` reports `configured: true` for a credential `hasConfiguredAuth()` rejects and that leaves the model unavailable | Section 6.6's launch check must gate on `getAvailable()`/`hasConfiguredAuth()`; "some authentication source is configured" is not a readiness test |

### 21.3 Two further notes for Phase 2

- **The E2E fake provider is de-risked and one trap is known.** A `models.json` provider with an
  OpenAI-compatible `baseUrl` and a placeholder `apiKey` is sufficient for a complete turn and for a
  tool call, so `TSK-0062` needs no paid account and no network. The trap: a fixture that re-issues
  the same tool call whenever it sees the triggering text loops until the timeout. It must answer
  once and return prose after a tool result is already in the conversation.
- **Missing authentication is a clean, distinguishable failure.** With no usable model the CLI exits
  1 and writes `No API key found for the selected model` to stderr while still emitting the session
  header on stdout — enough for setup to tell "no auth" apart from "package did not load", which are
  otherwise easy to confuse.

### 21.3b What Phase 1 could not prove

- **OAuth, for a built-in provider.** The API-key path *is* proved, with a control. OAuth is now
  **decided rather than open** (`DEC-0032`): it ships on Pi's public `/login` route and is verified
  by a manual account-bound run with a revocation control, never by a fabricated credential. The run
  is `TSK-0066` and its acceptance `ACC-0091`, both outstanding. Nothing in Phase 2's other work
  depends on it — but until it passes, no acceptance criterion may be written as though it were
  verified.
- **Attribution of the Windows environment injection.** The observable is retained and reproduced on
  both platforms; which layer supplies the names is not established and `AST-0045` no longer claims
  it.
- **Pi's authentication-only TUI and what it does with no TTY** (`TSK-0065`). It needs a real
  terminal, so it is a manually invoked check rather than a suite cell. ⚠️ Kiln's OWN refusal and
  recovery messaging is a separate obligation (`TSK-0068`, against the setup component) — it was
  split out because a criterion demanding a Kiln recovery route cannot be evaluated before setup
  exists.
- **The Kiln capability signature** (`TSK-0067`). It belongs to a package that does not exist yet; a
  spike cannot prove a property of something unbuilt.

⚠️ **`CMP-0041` was narrowed to match.** Its responsibility previously listed the authentication TUI,
OAuth discovery and the capability signature among what the suite establishes. It does not establish
them, and each is now a scheduled task with an acceptance criterion rather than a sentence in a
component description — which is the same failure, at smaller scale, that this whole cycle was opened
to undo.

### 21.4 Phase 1 exit state

- The graph carries the whole layer: 7 requirements, 21 new components, 58 acceptance criteria and
  53 tasks — the tasks carrying 88 `dependsOn` edges over two roots and no cycles, so section 17's
  order lives in the graph the schema calls authoritative rather than in this prose. Plus 6
  decisions and 8 questions, all answered — the last of them, OAuth discovery, by a decision about
  what would count as evidence rather than by a measurement.
- **Phase 2 does not begin with a Kiln component.** Its entry task depends on the two-step repair of
  the typed link layer (`DEC-0031`), because that defect was hit three times during Phase 1 and each
  repair required knowingly exploiting its companion bug. That ordering is an edge in the dependency
  graph rather than a sentence here — which is the same correction this section records elsewhere,
  applied to itself.
- **Every spike assertion derives as `supported / environment-matched`.** That is a separate check
  from "the measurement happened", and it failed the first time: the evidence environment facts were
  written as prose, the applicability filter compares them by exact equality, and ten of twelve
  assertions rested on nothing while reading as proved.
- The contract is **re-proved rather than retained**: `test/pi-compat.test.mjs` runs in the normal
  suite and fails when this document's pin no longer matches the pin the evidence was taken under,
  and CI re-runs the spike itself against a real consumer install.
- `implementedBy` is absent from every new component **except `CMP-0041`**, which is the one piece
  of this layer that Phase 1 actually built: the compatibility harness under `tools/pi-compat/`, its
  retained evidence, and `test/pi-compat.test.mjs`. Every other component describes designed and
  unbuilt work and does not pretend otherwise.
- **Stage 5's `data-model-approved` is deliberately left not satisfied.** The five persisted runtime
  shapes — `.pi/kiln.json`, `runtime/consent.json`, `runtime/model-compatibility.json`,
  `runtime/setup-transaction.json`, `runtime/kiln-session.json` — have decided locations and secrecy
  classes and no schemas. Authoring them, and enumerating the compatibility record's invalidation
  key set exactly, is the first design task of Phase 2 and precedes the code that writes those files.
  The handoff gate therefore refuses, which is the correct state for a plan mid-cycle.
