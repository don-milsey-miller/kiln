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

## Integration decision

Do not wire dynamic routing into setup, Pi tools, delegation, or launch yet. The current consent schema
holds one `modelUse` grant and the current compatibility location holds one record. Reusing either for a
pool would let one approval or proof stand for another model. Runtime integration therefore requires a
separate migration and setup UX, keyed host-local storage, atomic invalidation, and launch checks before
the prototype can safely become reachable.
