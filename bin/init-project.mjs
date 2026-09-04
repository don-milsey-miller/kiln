#!/usr/bin/env node
/**
 * `node .planning/bin/init-project.mjs` — create a project's `planning-content/`.
 *
 * ⚠️ **THIS IS THE FIRST KILN COMMAND ANYONE RUNS, AND IT RUNS BEFORE `npm install`.** Its whole
 * import graph is `node:` built-ins. A dependency here would mean the documented three-command start
 * — `git init`, `git clone … .planning`, this — failing on a missing package, after the user had
 * already cloned a tool that turned out to be unable to introduce itself.
 *
 * ⚠️ **IT PRINTS EVERY ABSOLUTE DIRECTORY IT WILL TOUCH, BEFORE IT TOUCHES ONE.** The failure this
 * prevents is not a crash; it is a command that succeeds against the wrong directory. `--project-root`
 * is relative to the shell's working directory and the two documented forms resolve differently —
 * `.` from the project and `..` from inside `.planning/` — so the one thing the operator must be able
 * to check at a glance is where the content is about to land.
 *
 * ⚠️ **THE THREE EXIT CODES MEAN DIFFERENT THINGS ON PURPOSE.** 0 is "the content root is there and
 * valid", which covers both a creation and a rerun that changed nothing; 1 is "there was something in
 * the way, or the attempt failed"; 2 is "the arguments or the target were wrong". A script that
 * re-runs this as part of a setup step needs to tell a harmless second run from a real conflict, and
 * one non-zero code for both would make that impossible.
 *
 * ⚠️ **SUCCESS IS ONLY PRINTED FOR A TREE THAT WAS READ BACK OFF DISK.** `initializeProject` validates
 * the generated content and reports `validated`, and this refuses to claim success without it. A
 * "created" message is the one output a user will not check.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";

import { initializeProject, REFUSAL_CLASS, STATUS } from "../lib/initialize-project.mjs";
import { toolRoot } from "../lib/content-root.mjs";

const USAGE = `Create a project's planning-content/ directory.

Usage:
  node .planning/bin/init-project.mjs --project-root <path> --name <name> [options]

Options:
  --project-root <path>   REQUIRED. The project that will CONTAIN planning-content/.
                          From the project itself this is \`.\`; from inside .planning/ it is \`..\`.
  --name <name>           REQUIRED in non-interactive mode. Written into project.yaml.
  --description <text>    Optional. What the project is intended to accomplish.
  --non-interactive       Refuse rather than prompting for anything missing.
  --help                  Print this and exit.

Examples:
  node .planning/bin/init-project.mjs --project-root . --name "My Project"
  npm --prefix .planning run init:project -- --project-root .. --name "My Project"

Exit codes:
  0  the content root was created, or already existed and is valid
  1  something was in the way, or initialization failed
  2  the arguments or the target directory were unusable
`;

const say = (msg) => console.log(`[kiln] ${msg}`);

/** Options that take a value. Anything else with a leading `--` is a mistake, not a project name. */
const VALUED = new Set(["--project-root", "--name", "--description"]);
const FLAGS = new Set(["--non-interactive", "--help", "-h"]);

/**
 * ⚠️ AN UNKNOWN OPTION IS AN ERROR, NEVER A POSITIONAL. `--nmae "My Project"` would otherwise be
 * silently discarded and the command would go on to prompt — or, non-interactively, to refuse for a
 * reason that has nothing to do with the actual typo.
 */
export function parseArgs(argv) {
  const out = { help: false, nonInteractive: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS.has(arg)) {
      if (arg === "--help" || arg === "-h") out.help = true;
      else out.nonInteractive = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const [flag, inlineValue] = eq > 2 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    if (!VALUED.has(flag)) return { error: `Unrecognised argument: ${arg}` };
    const value = inlineValue ?? argv[++i];
    if (value === undefined) return { error: `${flag} needs a value.` };
    if (flag === "--project-root") out.projectRoot = value;
    if (flag === "--name") out.name = value;
    if (flag === "--description") out.description = value;
  }
  return out;
}

async function prompt(question, { required }) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (await rl.question(question)).trim();
      if (answer.length > 0 || !required) return answer;
      console.error("  (required)");
    }
  } finally {
    rl.close();
  }
}

function fail(code, message) {
  console.error(`[kiln] ${message}`);
  process.exitCode = code;
}

/**
 * One line about what the ignore owner actually did.
 *
 * ⚠️ **A REPORT IS NOT A FAILURE AND NOT A SUCCESS, and it gets the most words** — it is the one
 * outcome where the operator has to do something, and where a line that scrolled past would leave
 * runtime paths unprotected while the command exited 0.
 */
function gitignoreLine(event) {
  if (event.changed !== true)
    return (
      `.gitignore:    NOT WRITTEN — ${event.detail ?? event.note ?? "nothing to do"}\n` +
      `               ${event.path}\n` +
      (event.uncovered?.length
        ? `               still not ignored: ${event.uncovered.join(", ")}\n` +
          `               Kiln will not write runtime state into a path Git is tracking. Add those\n` +
          `               lines yourself, or restore Kiln's block, before running setup.`
        : `               Nothing was changed.`)
    );

  const wrote = event.wrote?.join(", ") ?? "";
  if (event.action === "migrate") return `.gitignore:    migrated Kiln's block to ${wrote} in ${event.path}`;
  if (event.action === "create") return `.gitignore:    created ${event.path} with ${wrote}`;
  return `.gitignore:    appended ${wrote} to ${event.path}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    console.error(`[kiln] ${args.error}\n`);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (!args.projectRoot) {
    console.error("[kiln] --project-root is required, and it is deliberately not defaulted to the current directory:");
    console.error("[kiln] a command that creates a directory tree should not be guessing where.\n");
    console.error(USAGE);
    return 2;
  }

  // ⚠️ Identity is prompted for ONLY at a real terminal. In a script, a pipeline or CI there is
  // nobody to answer, and a prompt there is a hang rather than a question.
  const interactive = stdin.isTTY && stdout.isTTY && !args.nonInteractive;
  let name = args.name;
  let description = args.description;

  if (!name) {
    if (!interactive) {
      console.error("[kiln] --name is required. It is written into project.yaml and nothing can derive it.\n");
      console.error(USAGE);
      return 2;
    }
    name = await prompt("Project name: ", { required: true });
  }
  if (description === undefined && interactive)
    description = await prompt("What is this project intended to accomplish? (optional) ", { required: false });

  const notices = [];
  const result = await initializeProject({
    projectRoot: args.projectRoot,
    name,
    description: description ?? "",
    log: (event) => {
      if (event.kind === "paths") {
        say(`tool root:     ${event.toolRoot}`);
        say(`project root:  ${event.projectRoot}`);
        say(`content root:  ${event.contentRoot}`);
      }
      if (event.kind === "temp-directory") say(`staging in:    ${event.path}`);
      // ⚠️ WHAT IT SAYS COMES FROM WHAT THE OWNER DID, NOT FROM WHAT IT PLANNED. This line used to
      // read `action === "create" ? "created" : "appended"`, which was true of the only two actions
      // that existed — and would have announced an append for a migration, and for a report that
      // deliberately wrote nothing at all. Claiming a write that did not happen is the defect this
      // whole component exists to prevent, one layer up.
      if (event.kind === "gitignore") say(gitignoreLine(event));
      if (event.kind === "notice") notices.push(event.message);
    },
  });

  for (const notice of notices) say(notice);

  if (result.status === STATUS.REFUSED) {
    const code = result.refusalClass === REFUSAL_CLASS.INVALID_TARGET ? 2 : 1;
    console.error(`\n[kiln] REFUSED — ${result.message}`);
    if (result.conflicts?.length) {
      console.error(`\n[kiln] what is already in ${result.contentRoot}:`);
      for (const entry of result.conflicts.slice(0, 20)) console.error(`         ${entry}`);
      if (result.conflicts.length > 20) console.error(`         ... and ${result.conflicts.length - 20} more`);
      console.error(
        `\n[kiln] Nothing was written. If that content is a Kiln project, it is missing state/setup.json;\n` +
          `[kiln] if it is not, move it aside and run this again.`
      );
    }
    return code;
  }

  // ⚠️ NOT EXIT 0. A content root Kiln wrote, whose manifest or stage documents have since gone, is
  // not a project this command can call finished — and the next thing the user does after a success
  // message is run the app against it. Nothing is restored: rewriting a manifest under a project that
  // still holds the user's artifacts would be a worse answer than a non-zero exit.
  if (result.status === STATUS.DAMAGED) {
    console.error(`\n[kiln] DAMAGED — ${result.contentRoot} was initialized by Kiln, but is missing`);
    console.error(`[kiln] ${result.structural.length} path(s) it cannot work without:`);
    for (const p of result.structural) console.error(`         ${p.path}${p.kind === "directory" ? "/" : ""}`);
    console.error(
      `\n[kiln] Nothing was written and nothing was restored. Recover them from Git, or move the\n` +
        `[kiln] content root aside and initialize again.`
    );
    return 1;
  }

  if (result.status === STATUS.ALREADY_INITIALIZED) {
    say(`already initialized — nothing was written.`);
    if (result.drift.missing.length) {
      say(`${result.drift.missing.length} generated file(s) are MISSING, and were not restored:`);
      for (const f of result.drift.missing) say(`  - ${f}`);
      say(`Restore them from Git, or move the content root aside and initialize again.`);
    }
    if (result.drift.modified.length)
      say(
        `${result.drift.modified.length} generated file(s) have been edited since initialization. ` +
          `That is expected — they are yours — and nothing was overwritten.`
      );
    if (result.gitignore.recorded)
      say(`.gitignore:    recorded as "${result.gitignore.recorded}" at initialization; not re-checked.`);
    return 0;
  }

  if (result.status !== STATUS.CREATED || result.validated !== true) {
    fail(1, `initialization did not report a validated content root; refusing to claim success.`);
    return 1;
  }

  const shown = relative(process.cwd(), result.contentRoot) || result.contentRoot;
  say(`created ${result.files.length} file(s) in ${result.contentRoot}`);
  say(`git:           ${result.git.repository ? result.git.gitignore : "not a repository"}`);
  console.log("");
  say(`Next: describe the project in ${shown}/stages/01-intake.md, then start the app:`);
  say(`  npm --prefix ${relative(process.cwd(), toolRoot()) || toolRoot()} start`);
  return 0;
}

/**
 * ⚠️ RUN ONLY WHEN THIS FILE IS THE PROGRAM. `parseArgs` is exported so the argument contract can be
 * tested directly — an unknown option must be an error rather than a discarded positional — and
 * without this guard importing it would run the whole command against the TEST RUNNER's argv, in the
 * test runner's working directory. The exported function is the reason the guard exists.
 */
const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  try {
    process.exitCode = await main();
  } catch (e) {
    // ⚠️ A THROW HERE MEANS INITIALIZATION STARTED AND FAILED — exit 1, not 2. Exit 2 is reserved for
    // "your arguments were wrong", and reporting a mid-flight failure as a usage error would send the
    // user looking at their command line for a problem that is not there.
    console.error(`[kiln] initialization failed: ${e.message}`);
    if (e.problems?.length) for (const p of e.problems) console.error(`         ${p}`);
    console.error(`[kiln] Nothing was left behind: the content root is created only after it validates.`);
    process.exitCode = 1;
  }
}
