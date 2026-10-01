# Approved-model-pool routing investigation

Issue #71 is an architecture prerequisite, not an authorization to make Kiln's current launch path
dynamic. Kiln still launches the single provider, model, and thinking level explicitly selected in
`.pi/settings.json`. The prototype in `lib/decisioning/approved-model-pool.mjs` is deliberately not
registered as a Pi tool and cannot launch a request.

## Proposed records

The committed project record may eventually name a versioned, non-secret pool:

```json
{
  "recordVersion": 1,
  "entries": [{
    "id": "deep-planner",
    "provider": "provider-b",
    "model": "deep-2",
    "thinkingLevel": "high",
    "taskClasses": ["planning", "validation"],
    "capabilities": ["text", "tools"]
  }]
}
```

The closed shape intentionally has no credential, endpoint override, consent flag, price, account, or
host path. `id` is a stable routing label; provider, exact model, and thinking level remain explicit.
Task classes use Kiln's finite vocabulary. Capabilities are claims to be checked against Pi's current
model registry before the entry can be approved, not powers granted by the file.

Two ignored, host-local record families are required before runtime integration:

- One positive or negative consent entry per pool id, recording the exact provider/model/thinking
  identity and the credential route the operator confirmed. Approval of one entry grants no other
  entry, even at the same provider. Adding, changing, or re-adding an entry reopens confirmation.
- One compatibility record per pool id, using the existing complete compatibility key and passed
  canary result. The key is recomputed from current runtime inputs at every use. A missing, stale,
  invalid, tracked, committed, or unignored proof removes that entry from the candidate set.

No committed record is consent. A clone receives intent only and must establish its own approvals and
proofs. The decisioning-provider grant remains separate: allowing TypeSafe to rank identifiers does not
allow any candidate model to run.

## Deterministic narrowing before semantics

For a requested operation Kiln must first derive its task class and required capabilities. It then
intersects the committed pool with:

1. models currently present in Pi's inspected registry;
2. supported thinking levels;
3. an individually granted host-local consent entry with the same credential route;
4. a current, exact compatibility proof;
5. the operation's task class and capability requirements; and
6. any existing data-disclosure or provider restrictions.

Zero candidates refuses without inference or substitution. One candidate is selected deterministically.
Only two or more candidates reach Jev, which receives bounded metadata and chooses a pool id from that
closed set. The result is advisory, preserves all probabilities, and explicitly creates neither
execution nor billing authorization. The launch boundary must repeat every deterministic check before
use; a transcript recommendation is never a capability token.

## Host-local runtime prerequisite

Issue #82 adds `runtime/approved-model-pool-state.json`, a separately ignored and Git-checked host-local
record. It keeps each exact pool entry's positive or negative decision, credential route name, and
optional compatibility proof together. Removing an entry or changing its provider, model, or thinking
level removes the decision and proof in one atomic replacement. Changing a credential route replaces
that entry and clears its proof.

`configureApprovedModelPool()` is the setup-facing flow: it reconciles the committed pool, confirms each
new or changed entry independently, and allows a canary only after that entry receives an explicit yes.
`approvedModelPoolLaunchState()` is the launch-facing gate: it recomputes the complete compatibility key
from current runtime inputs for every positive entry and exports only exact, current proofs to the
bounded router. Neither function accepts a transcript's claim as authority.

The singleton migration is deliberately narrow. It moves an existing `modelUse` decision only when one
pool entry matches, and copies the old proof only when its complete key names that same exact identity.
Ambiguity migrates nothing. A clone receives none of these records.

Dynamic routing remains unregistered as a Pi tool and cannot launch a model. A later integration may
connect the guarded router only through these setup and launch boundaries; it must not reuse the legacy
singleton records or weaken the current single-model path.
