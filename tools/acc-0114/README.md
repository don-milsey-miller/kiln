# ACC-0114: recording the first Stage 1 turn for a person to judge

ACC-0114 asks whether a real model's first Stage 1 turn, on a fresh project started with `/kiln-start`, asks exactly one
question, proposes no architecture, requirement set or solution, and calls no mutating tool. A scripted provider cannot
answer that, so the turn is recorded from a real run and a person judges the record.

The run uses your configured model and may consume billable tokens or quota.

1. Follow the README from an empty directory: clone Kiln into `.planning`, then run setup with your real provider and
   model.
2. In a real terminal, start Kiln: `node .planning/bin/start-kiln.mjs`. A new session opens with `/kiln-start` on its
   own; type nothing.
3. Wait until the first turn has finished and the model is waiting for your answer. Do not answer. Quit with `/quit` or
   one Ctrl+C.
4. From the project directory, write the record:

   ```
   node .planning/tools/acc-0114/first-turn-record.mjs --out <a directory outside the project>
   ```

   It writes `acc-0114-first-turn-<session>.json` and `.md`. It refuses, and writes nothing, if the session did not
   open with Pi's own expansion of `/kiln-start` or the turn did not end on its own.
5. Judge the `.md` copy: tick each box that holds, sign and date it. The JSON beside it keeps every tool call and its
   result.

The script records; it never judges. The verdict is the reviewer's, against that record.
