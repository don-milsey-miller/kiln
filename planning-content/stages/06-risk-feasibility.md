# Stage 6 — Risk + Feasibility

> **Run 1 — 2026-08-22.** `decidedBy: Both`. Both exit criteria attested `satisfied`, and the run
> produced two findings that matter more than the attestations: **`risk` does not earn a type here**,
> and **one of the two criteria can pass vacuously.**
>
> **Run 2 — 2026-08-24 to 2026-08-26.** The stage **regressed and recovered**. See section 4. ⚠️ This
> document said "both satisfied" for two days while the attestation store said otherwise — the prose
> drifted, the state did not. Recorded rather than quietly fixed: it is a small instance of the
> semantic staleness #79 names, and this stage is where a plan is supposed to notice such things.

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

## 4. ⚠️ Run 2 — the stage regressed on its own product decision, then recovered

The regression was **caused by planning work, not discovered as a defect**, which is the healthy
version of this event.

**What reopened it.** `DEC-0018` adopted production mode (`next build` + `next start`) for the
application shell. `AST-0010`'s reopening condition read "execute before adopting `next build` /
`next start`, or when upgrading beyond the tested version" — and *both* clauses fired at once. Per
#80 the trigger fires when the risk becomes **possible**, not when it is observed, so the cost was
accepted knowingly rather than learned by shipping it. `high-severity-risks-mitigated` went
`not-satisfied` the same day the decision was taken.

**What the validation found, and why it was not a mitigation.** `EVD-0022` measured both caching
configurations at Next.js 16.3.2. The route prerendered static and served its build-time value in
**both**, so `AST-0019` records at rung 4 that the freeze is *unconditional*. That result did two
things: it confirmed the hazard, and it **removed the mitigation everyone would have reached for
first** — disabling Cache Components does not help.

⚠️ **The attestation's own exit condition was wrong, and the measurement is what exposed it.** It
had said the criterion returns to `satisfied` when `AST-0010` is validated, or on an accepted-risk
signoff. Both halves failed:

- *Validation is not mitigation.* Measuring a hazard precisely leaves it exactly as present as it
  was. A criterion that asks for a mitigation cannot be discharged by a better description of the
  problem.
- *An accepted-risk signoff was not available* — a fact about the requirements, not about appetite.
  `REQ-0016`–`REQ-0018` require current stage state, a rendered stage document, and reflection of
  external changes. Silently serving build-time content does not make those riskier; it **violates**
  them. A risk you can accept is one where the plan still holds if it lands.

**What actually mitigated it.** `QST-0023` produced `DEC-0019`: every server-side planning-content
read awaits `connection()` before the filesystem read, inside a `<Suspense>` boundary whose fallback
is a real loading state. `EVD-0023` had measured seven mechanism/model combinations — three are
fresh, and this is the only one fresh with Cache Components **both** enabled and disabled. The
deciding property is independence from a flag nobody has decided, not freshness.

`EVD-0024` then validated the contract *as written* rather than the mechanism again, and carried a
**negative control in the same build**: the same reads without the contract, stale in both
configurations. `AST-0021` records the result at rung 4. Without the control a fresh result could
not be told apart from a build that happened to be dynamic, and this criterion would have been
restored on a demonstration.

⚠️ **`AST-0022` is a finding this stage hands forward, and stage 7 must read it before writing
criteria.** A non-compliant read is served **fresh** whenever a compliant read shares its route — it
rides along on a route another component already made dynamic. So a violation passes every
behavioural freshness check until the compliant sibling moves, at which point every read on that
route silently reverts to build-time content. That is the failure mode `DEC-0019` rejected `io()`
for, reappearing one level down. The per-read clause forecloses it, **but only if it is enforced
statically**: an acceptance criterion that tests output freshness will report success on a codebase
that violates the contract.

**What `satisfied` means here, stated so it is not read as more.** The register's one outstanding
high-severity row has a mitigation that has been *run* — which is what this criterion asks at a stage
that precedes all implementation. It does **not** mean the application implements the contract; no
shell exists yet. That obligation belongs to stage 7.

---

## Exit criteria

| Criterion | Run 1 (2026-08-22) | Current (2026-08-26) |
|---|---|---|
| **high-severity-risks-mitigated** | ✅ `satisfied` — every register row mitigated; the expensive ones structurally absent rather than accepted. | ✅ `satisfied` — restored by the exit condition this attestation wrote for itself: `DEC-0019` is the design, `EVD-0024`/`AST-0021` is the validation, and a negative control makes it a validation rather than a demonstration. Went `not-satisfied` in between; see section 4. |
| **load-bearing-assertions-at-rung** | ✅ `satisfied` — `AST-0013` at the top rung. | ⬜️ `n/a` — re-measured, and the scope is **empty**: it is derived from graph use, and `RBS-0001` is retired so no active instruction rests on anything. `AST-0021` and `AST-0022` are load-bearing at rung 4 and are *still* not captured, which is the point of checking. ⚠️ The vacuity finding in section 3 stands, deliberately unfixed. |

⚠️ Run 1's `satisfied` on the second criterion is left in the table rather than corrected. It was
attested against `AST-0013` under a scope reading that later re-measurement narrowed to empty — and a
table that quietly restates history as if it had always been right is the drift this section opened
by naming.
