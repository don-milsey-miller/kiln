#!/usr/bin/env node
/**
 * 7a steps 3 and 4, as two deliberate commands.
 *
 *   npm run research:search -- "a question" --project-root <dir>
 *   npm run research:record -- <url> --claim "..." --quote "..." --project-root <dir> [--assertion AST-0001 --polarity support]
 *
 * ⚠️ **THE PROJECT IS NAMED, AND ITS RESEARCH MUST BE PERMITTED, BEFORE ANYTHING ELSE (F4, ACC-0120).** `--project-root` is
 * required; nothing is guessed from the working directory. The project must have chosen Tavily and this computer must
 * hold a standing research grant for it, checked before the key is read or any request made.
 *
 * ⚠️ **Two commands, not one, because discovery and evidence are different acts** (#124). Search
 * returns candidates; a human or a specialist then decides which source is authoritative and what it
 * actually says. A single command that searched and recorded would make the FIRST HIT into evidence,
 * which is the model's judgement wearing a citation.
 *
 * ⚠️ **`--quote` is verified against the fetched text before anything is written.** A citation for a
 * sentence that is not on the page is the failure mode a research capability exists to prevent — it is
 * #67's plausible prose with a URL attached, and it is *more* convincing than the prose was. So the
 * check is mechanical: if the quote is not in the retrieved document, the record is refused.
 *
 * ⚠️ **It runs in the PM's terminal, not the agent's.** The credential is read from the environment
 * and never printed (DEC-0006).
 *
 * ⚠️ **Nothing here calls `process.exit()`, and that is not a style preference.** Measured on this
 * Node build on Windows: `process.exit()` after ANY `fetch` aborts the process with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and returns 127 — so a correct refusal
 * looked like a crash and reported a crash's exit code. `process.exitCode` plus a natural drain exits
 * 1 cleanly. **A refusal that cannot be told apart from a failure defeats the clause it implements.**
 */

import { createResearchTools } from "../lib/research/tools.mjs";
import { createTavilyAdapter } from "../lib/research/tavily-adapter.mjs";
import { createEvidence, linkEvidence } from "../lib/tools/evidence-tools.mjs";
import { resolveContentRoot, resolveProjectRoot } from "../lib/content-root.mjs";
import { quoteIsPresent, flatten, extractTitle } from "../lib/research/quote.mjs";
import { RESEARCH_REFUSAL, researchPermission } from "../lib/research/permission.mjs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];

/**
 * Everything after `--name` up to the next `--flag`, joined.
 *
 * ⚠️ Not paranoia about npm: argv quoting was MEASURED intact through `npm run --` in both
 * PowerShell and bash. It joins because the failure mode if a shell ever does drop quotes is the
 * worst kind — `--claim "a b c"` would silently record the claim as `a`, a truncated sentence that
 * still validates and still reads like a claim. Joining cannot produce a worse value than taking
 * the first token, so it costs nothing to be safe here.
 */
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const parts = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) parts.push(argv[j]);
  return parts.length ? parts.join(" ") : undefined;
};

/**
 * The research tools, once the named project's research is permitted; `null` after printing why it is not.
 *
 * ⚠️ **THE ADAPTER IS BUILT ONLY HERE, AFTER THE GATE.** Nothing that could reach Tavily exists until the project and this
 * computer have both said yes.
 */
function permittedTools() {
  const root = flag("project-root");
  if (!root) {
    console.error("REFUSED     research-no-project-context");
    console.error("detail      Name the project whose research choice and consent apply: --project-root <dir>.");
    return { tools: null, code: 2 };
  }
  // Where this project keeps its runtime state, as setup was told with --local-state: the grant is read from there.
  const stateMode = flag("local-state") ?? "project";
  const gate = researchPermission({ projectRoot: resolve(root), stateMode });
  if (!gate.permitted) {
    console.error(`REFUSED     ${gate.reason}`);
    console.error(`detail      ${gate.detail}`);
    return { tools: null, code: 1 };
  }
  return { tools: createResearchTools(createTavilyAdapter()), code: 0, projectRoot: resolve(root) };
}

/** Every path that cannot proceed reports through here, so a refusal always looks like a refusal. */
function refuse(result) {
  console.error(`REFUSED     ${result.reason}`);
  console.error(`detail      ${result.detail}`);
  if (result.mustRecordGap)
    console.error("\nThis is a capability refusal. Record the gap; do NOT answer from model memory (DEC-0004).");
  return 1;
}

async function search() {
  // The words before the first flag: a flag's value is not part of the question.
  const words = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith("--")) break;
    words.push(a);
  }
  const query = words.join(" ");
  if (!query) {
    console.error('Usage: npm run research:search -- "your question" --project-root <dir> [--local-state project|user]');
    return 2;
  }
  const { tools, code } = permittedTools();
  if (!tools) return code;
  console.error("(one search credit)");
  const out = await tools.research_search({ query, maxResults: Number(flag("max") ?? 5) });
  if (out.ok === false) return refuse(out);

  console.log(`discovery for: ${out.query}\n`);
  out.results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.title ?? "(untitled)"}`);
    console.log(`   ${r.url}`);
    if (r.publishedAt) console.log(`   published ${r.publishedAt}`);
    if (r.snippet) console.log(`   ${r.snippet.replace(/\s+/g, " ").slice(0, 160)}`);
    console.log("");
  });
  console.log(out.note);
  console.log(`\nTo record one as evidence:\n  npm run research:record -- <url> --claim "..." --quote "exact sentence from the page"`);
  return 0;
}

async function record() {
  const url = argv[1];
  const claim = flag("claim");
  const quote = flag("quote");
  if (!url || url.startsWith("--") || !claim || !quote) {
    console.error('Usage: npm run research:record -- <url> --claim "what it supports" --quote "exact sentence from the page" --project-root <dir>');
    console.error("\n--quote is not optional: it is checked against the retrieved text before anything is written.");
    return 2;
  }

  // ⚠️ RESEARCH MUST BE PERMITTED FIRST (F4): it is the precondition every other one here serves.
  const { tools, code, projectRoot } = permittedTools();
  if (!tools) return code;

  // ⚠️ Resolve the content root BEFORE fetching anything. The first version fetched the page and
  // THEN discovered it had nowhere to write, which is #125's "refuse before provisioning" ignored in
  // miniature: a precondition checked after the irreversible part is a report, not a check. Here the
  // waste is one HTTP request; the habit is what matters.
  let contentRoot;
  try {
    // ⚠️ **AND IT MUST BELONG TO THE PROJECT WHOSE CONSENT WAS READ.** The evidence is written where the content-root
    // rule or PLANNING_CONTENT_DIR points, which is decided apart from --project-root; a destination owned by another
    // project would record research that project never permitted. A disagreement refuses before anything is fetched.
    resolveProjectRoot({ expect: projectRoot });
    contentRoot = resolveContentRoot();
  } catch (e) {
    if (/^Project root disagreement/.test(e?.message ?? "")) {
      console.error(`REFUSED     ${RESEARCH_REFUSAL.DESTINATION_MISMATCH}`);
      console.error(e.message);
      console.error("\nNothing was fetched or recorded.");
      return 2;
    }
    console.error(e.message);
    console.error(
      "\nIf this is the Kiln repository itself, it is its own consumer and the sibling rule does not\n" +
        "apply to it — name its content directory explicitly:\n" +
        "  PowerShell   $env:PLANNING_CONTENT_DIR = (Resolve-Path .\\planning-content).Path\n" +
        '  sh           PLANNING_CONTENT_DIR="$PWD/planning-content"'
    );
    return 2;
  }

  const got = await tools.research_fetch({ url });
  if (got.ok === false) return refuse(got);

  if (!quoteIsPresent(got.body, quote)) {
    console.error("REFUSED     quote-not-found");
    console.error(`detail      That sentence is not in the retrieved document (${got.url}).`);
    console.error("\nNothing was recorded. A citation for text that is not on the page is worse than no");
    console.error("citation: it is a claim that has borrowed someone else's authority.");
    return 1;
  }

  const title = flag("title") ?? extractTitle(got.body) ?? got.url;
  const evidence = await createEvidence(
    {
      title: `Source: ${title}`.slice(0, 200),
      kind: "source",
      summary: claim,
      sources: [{ title, locator: got.url, retrievedAt: got.retrievedAt.slice(0, 10) }],
      notes:
        `Quoted from the page, verified present at retrieval time: "${flatten(quote).slice(0, 400)}"` +
        (got.redirectChain.length > 1 ? ` ⚠️ Retrieved via redirect chain: ${got.redirectChain.join(" -> ")}.` : "") +
        " ⚠️ The full document was NOT retained — there is no capture store yet (7b builds capture plans)." +
        " What survives is the locator, the retrieval date and the verified quote.",
    },
    { contentRoot }
  );
  console.log(`recorded    ${evidence.id}  (evidence, kind: source)`);
  console.log(`source      ${got.url}`);
  console.log(`retrieved   ${got.retrievedAt}`);

  const assertion = flag("assertion");
  if (assertion) {
    const polarity = flag("polarity") ?? "support";
    await linkEvidence(assertion, evidence.id, polarity, { contentRoot });
    console.log(`linked      ${assertion} <- ${evidence.id} (${polarity})`);
  } else {
    console.log("\nNot linked to any assertion. Bearing is a separate judgement (#123): link it with");
    console.log("  --assertion AST-#### --polarity support|refute");
  }
  return 0;
}

if (cmd === "search") process.exitCode = await search();
else if (cmd === "record") process.exitCode = await record();
else {
  console.error('Usage:\n  npm run research:search -- "a question" --project-root <dir>\n  npm run research:record -- <url> --claim "..." --quote "..." --project-root <dir>');
  process.exitCode = 2;
}
