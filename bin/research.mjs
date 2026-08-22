#!/usr/bin/env node
/**
 * 7a steps 3 and 4, as two deliberate commands.
 *
 *   npm run research:search -- "a question"
 *   npm run research:record -- <url> --claim "..." --quote "..." [--assertion AST-0001 --polarity support]
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
import { resolveContentRoot } from "../lib/content-root.mjs";
import { quoteIsPresent, flatten, extractTitle } from "../lib/research/quote.mjs";

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

const tools = createResearchTools(createTavilyAdapter());

/** Every path that cannot proceed reports through here, so a refusal always looks like a refusal. */
function refuse(result) {
  console.error(`REFUSED     ${result.reason}`);
  console.error(`detail      ${result.detail}`);
  if (result.mustRecordGap)
    console.error("\nThis is a capability refusal. Record the gap; do NOT answer from model memory (DEC-0004).");
  return 1;
}

async function search() {
  const query = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!query) {
    console.error('Usage: npm run research:search -- "your question"');
    return 2;
  }
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
    console.error('Usage: npm run research:record -- <url> --claim "what it supports" --quote "exact sentence from the page"');
    console.error("\n--quote is not optional: it is checked against the retrieved text before anything is written.");
    return 2;
  }

  // ⚠️ Resolve the content root BEFORE fetching anything. The first version fetched the page and
  // THEN discovered it had nowhere to write, which is #125's "refuse before provisioning" ignored in
  // miniature: a precondition checked after the irreversible part is a report, not a check. Here the
  // waste is one HTTP request; the habit is what matters.
  let contentRoot;
  try {
    contentRoot = resolveContentRoot();
  } catch (e) {
    console.error(e.message);
    console.error("\nThis repo is its own consumer, so the default rule does not apply to it. Set:");
    console.error('  $env:PLANNING_CONTENT_DIR = "D:\\visual-project-workflow\\planning-content"');
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
  console.error('Usage:\n  npm run research:search -- "a question"\n  npm run research:record -- <url> --claim "..." --quote "..."');
  process.exitCode = 2;
}
