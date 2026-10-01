# Optional semantic decisioning with TypeSafe Jev

Kiln can use TypeSafe Jev for six bounded, advisory decisions:

- classify a user request into an activity and tool family already permitted by the current stage;
- compare a proposed artifact with selected existing artifacts as `distinct`, `duplicate`, `overlaps`,
  `refines`, or `contradicts`.
- rank only the trace targets that Kiln has already proved structurally legal for a source field.
- verify whether linked evidence semantically supports, contradicts, or says nothing about its assertion.
- review validated planning artifacts for bounded quality concerns without affecting deterministic lint.
- review a deterministically permitted material-change proposal before operator approval.

Jev never grants a tool, changes project state, satisfies a stage gate, records an approval, or replaces
Kiln's deterministic validation. If TypeSafe is unavailable or returns an answer outside the permitted
contract, Kiln returns a structured fallback to its existing Pi reasoning path.

## Enable it

Set the credential in the host environment, then explicitly configure the project.

PowerShell:

```powershell
$env:TYPESAFE_API_KEY = "..."
npm --prefix .planning run decisioning:configure -- --project-root . --provider typesafe
```

macOS or Linux:

```sh
TYPESAFE_API_KEY="..." npm --prefix .planning run decisioning:configure -- \
  --project-root . --provider typesafe
```

The command first authenticates with TypeSafe's model-list endpoint, which does not run inference. Only
after that probe succeeds does it record both parts of the opt-in:

- `.pi/kiln.json` records the non-secret project choice `decisioning.provider = "typesafe"`;
- the ignored local consent record grants this computer permission to use TypeSafe for that project.

The API key remains in the process environment. It is not written to either record, planning content,
tool output, or logs. Enabling decisioning allows Kiln to send the current request and bounded stage state
for routing, and the proposed text plus explicitly selected artifacts for comparison, to TypeSafe.

For per-user local state, add `--local-state user` to every decisioning command, matching setup.

Disable the feature and clear this host's grant with:

```sh
npm --prefix .planning run decisioning:configure -- --project-root . --provider none
```

## Check and exercise it

```sh
npm --prefix .planning run decisioning:probe -- --project-root .

npm --prefix .planning run decisioning:route -- \
  --project-root . \
  --request "Split authentication into its own requirement"

npm --prefix .planning run decisioning:compare -- \
  --project-root . \
  --type requirement \
  --content "Normal API requests must complete within 500 ms" \
  --candidates REQ-0012,REQ-0027

npm --prefix .planning run decisioning:trace -- \
  --project-root . \
  --source CMP-0001 \
  --field satisfies \
  --candidates REQ-0012,REQ-0027

npm --prefix .planning run decisioning:evidence -- \
  --project-root . \
  --assertion AST-0001 \
  --evidence EVD-0001

npm --prefix .planning run decisioning:review -- \
  --project-root . \
  --artifacts REQ-0001,ACC-0001

npm --prefix .planning run decisioning:proposal -- \
  --project-root . \
  --operation mutate:reviseArtifact \
  --proposal "Add an authentication constraint" \
  --targets REQ-0001 \
  --context DEC-0001
```

The Pi package exposes the same operations as `kiln_decisioning_capability`, `kiln_route_turn`,
`kiln_compare_artifacts`, `kiln_rank_trace_targets`, `kiln_verify_evidence_relationship`, and
`kiln_semantic_review`, and `kiln_review_proposal`. Route results include full Choice probabilities and confidence plus the
deterministic next action. Comparison results include one probability distribution per candidate.
Trace recommendations preserve the same distributions but cannot create a trace or widen the target
types declared by the source artifact's schema.

Evidence verification reads the canonical `supportedBy` or `refutedBy` edge first, then compares it
with Jev's semantic assessment. Disagreement sets `reviewRecommended:true`; it never changes the edge,
the evidence lifecycle, the derived verdict, or the confidence rung.

`kiln_semantic_review` reports bounded concerns such as compound scope, subjectivity, misalignment,
overlap, or excessive breadth. Its result is explicitly `advisory-semantic-review` with
`gateEffect:"none"`; `kiln_lint` remains the deterministic, reproducible, gate-capable check.

`kiln_review_proposal` runs only after Kiln proves that the named create or mutate operation is legal
for the current stage. It can surface duplication, contradiction, scope expansion, non-goal conflict,
wrong-target, or wrong-stage concerns before the proposal is presented. The result carries
`mayMutate:false` and `approvalRecorded:false`; provider failure falls back to the existing operator
approval path.

When both research and decisioning have been separately enabled, `research_search` performs semantic
triage after the authorized backend returns results. Results classified `essential`, `relevant`, or
`uncertain` remain in downstream context; `duplicate` and `irrelevant` snippets are omitted while their
titles, URLs, assessments, probabilities, and usage remain visible in `triage.omitted`. If the backend
is unavailable or returns an invalid decision, every original result is returned.

Kiln intentionally ships no automatic-action confidence threshold. Thresholds must be calibrated against
project-specific examples and a pinned Jev model before they can safely suppress context or automate a
branch. Until then, every result is an advisory input to Pi or the operator.

## Architecture

The integration is separated into four layers:

1. `lib/decisioning/tools.mjs` owns Kiln's task-specific, vendor-neutral contract.
2. `lib/decisioning/policy.mjs` derives the closed choices Jev may see from authoritative stage rules.
3. `lib/decisioning/typesafe-adapter.mjs` owns the SDK, credential, transport, and error mapping.
4. `lib/decisioning/permission.mjs` proves project choice and local consent before the adapter is built.

That boundary keeps the integration reversible: canonical artifacts contain no TypeSafe-specific fields,
and selecting `none` restores the existing behavior without migrating planning content.
