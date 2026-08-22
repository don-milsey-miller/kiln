# Stage 6 — Risk + Feasibility

> **Run 2026-08-22.** `decidedBy: Both`. Both exit criteria are attested `satisfied`, and the run
> produced two findings that matter more than the attestations: **`risk` does not earn a type here**,
> and **one of the two criteria can pass vacuously.**

---

## 1. Does `risk` earn a type? — #41 applied

**No, and the reason is a comparison rather than a preference.** `component` was approved (#140)
because **four consumers were already decided before the type was proposed** — #60's cascade, #19's
role slicing, the stage-9 orphan check, and stage 5's own exit criterion. `risk` has **one**: this
stage's own `high-severity-risks-mitigated` criterion.

| #41's test | `risk` |
|---|---|
| **Irreducible state** | Plausibly yes — severity, mitigation, and an accepted-risk signoff are not derivable from anything else. A risk is not an assertion (a claim about what *is*, where a risk is about what *might be*) and not a question (answerable, where a risk may be known and simply accepted). |
| **Consumer that must traverse it** | ⚠️ **One, and it is this stage's own criterion.** Nothing else reads a risk. Not the cascade, not the handoff, not the lint. |

⚠️ **A type whose only consumer is the criterion that demands it is the catalogue justifying itself**
— the exact pattern #106 was written against. #119 already recorded that **no requirement mentions
risk at all**, and running the stage did not change that: the register was consulted, it was
sufficient, and nothing needed to traverse it.

✅ **So the prose register in `notes.md` stays**, and that is #41 working rather than a shortcut:
prose is the correct home for material nothing must traverse. **The cost is stated in the
attestation** — this criterion is evaluable only by a human reading a table, where stage 5's is now a
mechanical check.

⚠️ **Reopening condition:** build `risk` when something other than a stage-6 criterion must traverse
one — a handoff that must carry a risk register to the recipient, a cascade that must flag risks when
an assumption moves, or a requirement that asks for risk tracking. **None exists today.**

## 2. The register, walked

Nineteen rows. Every one carries a mitigation in the design. The highest-cost rows are mitigated
**structurally rather than by intention**, which is the distinction worth checking:

| Risk | Why it is not live |
|---|---|
| Credential exposure · cost runaway · resource leakage · destructive experimentation | **All tier-3-only, and tier 3 is not activated.** Not accepted risks — **absent** ones. A project that never activates the tier never loads a provider or holds a credential. |
| False determinism (rung 4 read as rung 5) | #42 caps the MVP at rung 4 and `mayBecomeInstruction` enforces the threshold. **Implemented and tested.** |
| Environment mismatch | #96's applicability filter, and #134's claim-relative isolation comparison. **Implemented and tested.** |
| Silent tier downgrade | #77 probes the capability rather than the binary; `validation_capability` reports `not-configured` rather than failing at provision. **Implemented.** |
| Agent role leakage | #26's contracts, now mechanical: `lib/specialists/contract.mjs` enforces write boundaries by **absence**, and #81 refuses output from a child that cannot demonstrate its tools. |
| Stub completion | The lint checks substance, not presence — `content/hollow-value`, `content/placeholder-marker`, `content/thin-na-reason`. |
| The schemas are the critical path | ⚠️ **Materially reduced by evidence rather than by work:** #139 and #136 showed two stages needing none of their declared types, and the catalogue is now **eight activated types**, not sixteen. The critical path shrank because demand was measured. |

## 3. ⚠️ A criterion that can pass vacuously

`load-bearing-assertions-at-rung` asks that *every load-bearing assertion has reached its required
confidence rung*. **Exactly one assertion carries `loadBearing: true`** — `AST-0013`, at
`environment-matched`. So the criterion passes.

**But `RBS-0001` rests on `AST-0002`, and `AST-0002` is not flagged `loadBearing`.**

An instruction resting on an unflagged claim would satisfy this criterion **while being precisely what
#57 exists to prevent.** Nothing is wrong today — `AST-0002` is at `environment-matched`, well above
any threshold — and the real enforcement lives in `mayBecomeInstruction`, which reads the derived view
rather than the flag. **But a criterion whose scope is set by an author-supplied boolean can be
satisfied by not setting the boolean**, and that is worth naming rather than leaving for someone to
discover at a gate.

⚠️ **Not fixed here, deliberately.** Rewording an exit criterion is a change to the methodology
(#90/#91), and the honest sequence is to record the finding from a real run first. The candidate
rewording — *every assertion an instruction rests on* — is derivable from `restsOn` and needs no flag
at all, which is the same move #84 made for membership.

---

## Exit criteria

| Criterion | Attestation |
|---|---|
| **high-severity-risks-mitigated** | ✅ `satisfied` — every register row mitigated; the expensive ones structurally absent rather than accepted. Basis is prose, and the attestation says so. |
| **load-bearing-assertions-at-rung** | ✅ `satisfied` — `AST-0013` at the top rung. ⚠️ With the vacuity finding recorded above. |
