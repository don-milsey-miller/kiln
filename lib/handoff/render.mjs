/**
 * Render the handoff package — deterministically.
 *
 * ⚠️ **Byte-identical output for identical input is the property everything else here serves.** It is
 * what makes the package reviewable in a diff: a change in the diff means a change in the PLAN, never
 * a change in the clock. So there are **no wall-clock timestamps anywhere in the output**, keys are
 * sorted, arrays are ordered by ID, and the package's identity is a **content hash of the canonical
 * input** — which is deterministic AND a genuine version identifier, where a timestamp is neither.
 *
 * ⚠️ **Nothing authored enters the package.** Every file is derived from `planning-content` plus the
 * tool version. There is no place for a human to write into the output, because a package that can be
 * edited is a package whose diff no longer means what it says.
 *
 * ⚠️ **Only ACTIVATED types are rendered, and a deactivated type is ABSENT rather than empty.** An
 * empty `runbooks.json` would imply the question was asked and the answer was "none"; absence implies
 * the question does not apply to this project, which is what deactivation means (#140).
 */

import { createHash } from "node:crypto";
import { effectiveAssertion } from "../effective-assertion.mjs";

/** Stable JSON: sorted keys, two-space indent, trailing newline. */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value), null, 2) + "\n";
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

const byId = (a, b) => String(a.id).localeCompare(String(b.id));

/**
 * Build the package as a map of relative path -> file contents.
 *
 * @param {{records: Array<{doc: object}>, activated: string[], toolVersion: string, stageDocs: Map<string,string>}} input
 */
export function renderPackage(input) {
  const docs = input.records.map((r) => r.doc).filter(Boolean).sort(byId);
  const activated = new Set(input.activated);

  // ⚠️ EVERY activated type gets an entry, even with no records — and a DEACTIVATED type gets none.
  // The first draft only created entries for types that had artifacts, which collapsed two different
  // facts into one silence: "this type does not apply to this project" and "it applies and there are
  // none yet". Found by the removed-source test, which deleted the last component and then could not
  // find the file that should have said there were zero.
  const byType = new Map([...activated].sort().map((t) => [t, []]));
  for (const d of docs) {
    if (!activated.has(d.type)) continue;
    byType.get(d.type).push(d);
  }

  const evidenceById = new Map(docs.filter((d) => d.type === "evidence").map((d) => [d.id, d]));
  const files = new Map();

  // --- data/: canonical, for automated consumers -------------------------------------------
  for (const [type, items] of [...byType.entries()].sort()) {
    const rendered =
      type === "assertion"
        ? items.map((a) => {
            // ⚠️ verdict and confidence are DERIVED here at render time and labelled derived, per
            // #96: this is the one point where a rung is materialised, and it says so rather than
            // looking like something someone stored.
            const view = effectiveAssertion(a, evidenceById);
            return {
              ...a,
              derived: {
                verdict: view.verdict,
                confidence: view.confidence,
                applicable: view.applicable.map((c) => ({ ref: c.ref, polarity: c.polarity, match: c.match ?? null })),
                excluded: view.excluded.map((c) => ({ ref: c.ref, because: c.excludedBecause })),
                note: "Derived at render time from the evidence graph (#96). Not stored on the artifact.",
              },
            };
          })
        : items;
    files.set(`data/${type}s.json`, canonicalJson(rendered));
  }

  // --- docs/: stage narratives, exactly as authored in planning-content -----------------------
  for (const [name, text] of [...(input.stageDocs ?? new Map()).entries()].sort())
    files.set(`docs/${name}`, text);

  // --- slices/: one per role, as a QUERY over the task graph (#19) ------------------------------
  // ⚠️ Nothing here is authored or maintained. A slice is recomputed from `task.role` on every
  // render, which is what makes it impossible for a slice to drift from the plan — and why
  // `role-assignment` was refused as a type (#143): the role SET is derived by collecting.
  for (const [role, slice] of roleSlices(byType)) files.set(`slices/${slugify(role)}.json`, canonicalJson(slice));

  // --- PLAN.md: the single-file bundle --------------------------------------------------------
  files.set("PLAN.md", renderPlanMarkdown(byType, evidenceById));

  // --- identity ------------------------------------------------------------------------------
  // The hash covers everything rendered SO FAR, so the manifest identifies the package it is in.
  const contentHash = hashFiles(files);
  files.set(
    "MANIFEST.json",
    canonicalJson({
      snapshot: contentHash,
      toolVersion: input.toolVersion,
      activated: [...activated].sort(),
      counts: Object.fromEntries([...byType.entries()].map(([t, i]) => [t, i.length]).sort()),
      // ⚠️ DEC-0015. The first real package described itself as approved state while 98 of its 99
      // artifacts were `draft` — an ambiguity a machine consumer could see and not resolve. The
      // basis is now stated rather than implied, and the counts let a consumer check it.
      approval: {
        package: "Approved at STAGE level: every declared exit criterion is attested (#93). See docs/*.md for each stage's reasoning.",
        artifacts: "Per-artifact `reviewStatus` is an authoring state and is NOT a publication gate, except for executable content.",
        executableContentRequiresApproval: ["runbook-step", "task"],
        reviewStatusCounts: reviewCounts(byType),
      },
      note:
        "Generated by `npm run handoff`. `snapshot` is a content hash of every CONTENT file in this " +
        "package — data/, docs/, slices/ and PLAN.md. ⚠️ README.md and MANIFEST.json are NOT covered, " +
        "because both embed the snapshot and cannot be inside it. Identical content and tool version " +
        "therefore produce an identical snapshot; the converse does NOT hold if the TOOL changed without " +
        "its version changing — see QST-0016. There are deliberately no timestamps here: a timestamp " +
        "would make two identical plans look different, which is the opposite of what an identifier is for.",
    })
  );
  files.set("README.md", renderReadme(contentHash, input.toolVersion, byType));

  return files;
}

/** A stable hash over path+content pairs, in sorted path order. */
export function hashFiles(files) {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    h.update(path);
    h.update("\0");
    h.update(files.get(path));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function renderReadme(snapshot, toolVersion, byType) {
  const counts = [...byType.entries()].sort().map(([t, i]) => `- ${i.length} ${t}${i.length === 1 ? "" : "s"}`);
  return `# Handoff package

**Generated. Nothing here was written by hand**, and editing it edits a rendering — the next
\`npm run handoff\` overwrites you. Change \`planning-content/\` instead.

- snapshot: \`${snapshot}\`
- tool version: \`${toolVersion}\`

## What is in it

${counts.join("\n")}

## How to read it

- \`data/*.json\` is canonical and is what an automated consumer should read.
- \`docs/*.md\` is the same material for a human reading in the repository.
- \`PLAN.md\` is everything in one file, for dropping into a single context window.

⚠️ **Assertions carry a \`derived\` block** holding verdict and confidence. Those are computed from the
evidence graph at render time and are not stored on the artifacts — if you change the evidence, they
change. Nothing in this package asserts a confidence anyone typed.
`;
}

export function renderPlanMarkdown(byType, evidenceById) {
  const out = ["# Plan", "", "Generated. Every claim below links to what it rests on.", ""];

  // ⚠️ The human surface must not lose what the machine surface records. The first real package
  // rendered retired REQ-0015 as an ordinary must-have requirement while the JSON said
  // `lifecycle: retired` — a parity break REQ-0011 forbids, and one only the frozen output showed.
  const section = (title, items, render) => {
    const current = (items ?? []).filter(isCurrent);
    if (!current.length) return;
    out.push(`## ${title}`, "");
    for (const d of current) out.push(...render(d), "");
  };

  section("Requirements", byType.get("requirement"), (d) => [
    `### ${d.id} — ${d.title ?? ""}`.trim(),
    "",
    d.statement ?? "",
    d.priority ? `\n*Priority: ${d.priority}*` : "",
  ]);

  section("Components", byType.get("component"), (d) => [
    `### ${d.id} — ${d.title ?? ""}`.trim(),
    "",
    d.responsibility ?? "",
    `\n*Satisfies: ${(d.satisfies ?? []).join(", ") || "nothing"}*`,
    (d.implementedBy ?? []).length ? `*Implemented by: ${d.implementedBy.join(", ")}*` : "*Not yet implemented.*",
  ]);

  section("Decisions", byType.get("decision"), (d) => [
    `### ${d.id} — ${d.title ?? ""}`.trim(),
    "",
    d.statement ?? "",
    d.rationale ? `\n**Why:** ${d.rationale}` : "",
  ]);

  section("Claims", byType.get("assertion"), (d) => {
    const view = effectiveAssertion(d, evidenceById);
    return [
      `### ${d.id} — ${d.title ?? ""}`.trim(),
      "",
      d.statement ?? "",
      `\n**${view.verdict} · ${view.confidence}** (derived)`,
      view.applicable.length ? `\nRests on: ${view.applicable.map((c) => `${c.ref} (${c.polarity})`).join(", ")}` : "",
      view.excluded.length ? `\nExcluded: ${view.excluded.map((c) => `${c.ref} — ${c.excludedBecause}`).join(", ")}` : "",
    ];
  });

  section("Open questions", (byType.get("question") ?? []).filter((q) => q.resolution !== "answered"), (d) => [
    `### ${d.id} — ${d.title ?? ""}`.trim(),
    "",
    d.statement ?? "",
    (d.blocks ?? []).length ? `\n*Blocks: ${d.blocks.join(", ")}*` : "",
  ]);

  const criteriaById = new Map((byType.get("acceptance-criterion") ?? []).map((c) => [c.id, c]));
  section("Tasks", byType.get("task"), (d) => {
    const st = taskStatus(d, criteriaById);
    return [
      `### ${d.id} — ${d.title ?? ""}`.trim(),
      "",
      d.statement ?? "",
      `\n**${st.status}** (${st.passed}/${st.total} criteria passed) · role: ${d.role}`,
      `*Implements: ${(d.implements ?? []).join(", ")} · fulfils: ${(d.fulfils ?? []).join(", ")}*`,
    ];
  });

  section("Runbook steps", byType.get("runbook-step"), (d) => [
    `### ${d.id} — ${d.title ?? ""}`.trim(),
    "",
    d.instruction ?? "",
    d.expectedOutcome ? `\n**Expected:** ${d.expectedOutcome}` : "",
    `\n*Rests on: ${(d.restsOn ?? []).join(", ") || "nothing"}*`,
  ]);

  // ⚠️ Retired material is listed, not dropped. Filtering it out of the sections above and then
  // omitting it entirely would make this rendering disagree with the machine data in the other
  // direction — the recipient would have no way to learn a requirement had been withdrawn.
  const retired = [...byType.values()].flat().filter((d) => !isCurrent(d)).sort(byId);
  if (retired.length) {
    out.push("## Retired and superseded", "");
    out.push("⚠️ **Not part of the current plan.** Listed because removing them silently would make this");
    out.push("rendering disagree with the machine-readable data, which is the parity REQ-0011 requires.", "");
    for (const d of retired) out.push(`- **${d.id}** (${d.type}, ${d.lifecycle}) — ${d.title ?? d.statement ?? ""}`.trim());
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** `role` -> a slug safe as a filename, and stable so the package stays byte-identical. */
export const slugify = (role) => String(role).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Build one slice per role, by QUERY (#19).
 *
 * ⚠️ **A slice pulls each task's traced requirements and acceptance criteria along with it**, so the
 * recipient does not have to open the full package to learn what they are building or how they will
 * know it is done. That pulling is the whole content of stage 9's `role-slice-self-sufficient`
 * criterion — a slice that only listed task IDs would satisfy the filename and not the requirement.
 *
 * ⚠️ **Roles come from collecting `task.role`.** There is no roster, by #18, and no `role-assignment`
 * type, by #143 — so a role exists exactly when a task is assigned to it, and disappears when the
 * last such task does. Nothing can drift, because there is nothing to keep in step.
 */
export function roleSlices(byType) {
  const tasks = byType.get("task") ?? [];
  const index = (type) => new Map((byType.get(type) ?? []).map((d) => [d.id, d]));
  const requirements = index("requirement");
  const criteria = index("acceptance-criterion");
  const components = index("component");

  const roles = [...new Set(tasks.filter(isCurrent).map((t) => t.role).filter(Boolean))].sort();
  return roles.map((role) => {
    const mine = tasks.filter((t) => t.role === role && isCurrent(t)).sort(byId);
    // ⚠️ Retired material is filtered from what a slice PULLS. A retired requirement travelling into
    // a slice would be read as work to do, which is the same defect as an accepted task doing so.
    const pull = (ids, from) => [...new Set(ids)].sort().map((id) => from.get(id)).filter(Boolean).filter(isCurrent);
    const withStatus = mine.map((t) => ({ ...t, derivedStatus: taskStatus(t, criteria) }));
    const outstanding = withStatus.filter((t) => t.derivedStatus.status !== "accepted");
    const accepted = withStatus.filter((t) => t.derivedStatus.status === "accepted");
    return [
      role,
      {
        role,
        note:
          "Generated as a query over the task graph, grouped by `task.role` (#19). Nothing here is " +
          "authored: re-running the handoff recomputes it, so a slice cannot drift from the plan. " +
          "`tasks` is work REMAINING; `accepted` is work already finished, listed so nobody repeats it. " +
          "Both statuses are derived from acceptance criteria, never stored.",
        tasks: outstanding,
        accepted,
        // Everything the tasks trace to, so the slice stands alone.
        requirements: pull(mine.flatMap((t) => t.fulfils ?? []), requirements),
        acceptanceCriteria: pull(mine.flatMap((t) => t.acceptedBy ?? []), criteria),
        components: pull(mine.flatMap((t) => t.implements ?? []), components),
        // ⚠️ Dependencies on work assigned to SOMEONE ELSE. A recipient who cannot see these would
        // read a self-sufficient slice and still be blocked by something outside it.
        blockedByOtherRoles: mine
          .flatMap((t) => (t.dependsOn ?? []).map((id) => tasks.find((x) => x.id === id)))
          .filter((t) => t && t.role !== role)
          .map((t) => ({ task: t.id, role: t.role }))
          .sort((a, b) => a.task.localeCompare(b.task)),
      },
    ];
  });
}

/**
 * Derive a task's status from its acceptance criteria. **Derived, never stored** (#96, and DEC-0012
 * for the same reason on components): a task is done when the things that accept it pass, and a
 * stored `done` flag would keep saying done after a criterion started failing.
 *
 * ⚠️ **Written because the first real package could not tell a recipient which work was left.**
 * `slices/platform.json` listed a finished task and an unstarted one identically, and a recipient
 * following it would have redone completed work. Fixture testing never saw it — the fixture had no
 * tasks at all.
 *
 * @returns {{status: "accepted"|"outstanding"|"unaccountable", passed: number, total: number}}
 */
export function taskStatus(task, criteriaById) {
  const refs = task.acceptedBy ?? [];
  const criteria = refs.map((id) => criteriaById.get(id)).filter(Boolean);
  const passed = criteria.filter((c) => c.outcome === "pass").length;
  // ⚠️ No criteria is NOT "outstanding" — it is `unaccountable`, a third state, because nothing can
  // say when it is finished. The publish gate refuses on it rather than shipping it as work.
  if (refs.length === 0) return { status: "unaccountable", passed: 0, total: 0 };
  return { status: criteria.length > 0 && passed === criteria.length ? "accepted" : "outstanding", passed, total: refs.length };
}

/** Everything the plan currently asserts. Retired and superseded artifacts are not part of it. */
export const isCurrent = (d) => (d.lifecycle ?? "active") === "active";

/** How many artifacts sit at each review status, so a consumer can check the MANIFEST's claim. */
export function reviewCounts(byType) {
  const counts = {};
  for (const items of byType.values()) for (const d of items) counts[d.reviewStatus] = (counts[d.reviewStatus] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort());
}
