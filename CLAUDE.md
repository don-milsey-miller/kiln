# Working in this repository

## Commit and pull-request attribution

**This repository's commits and pull request descriptions carry no assistant attribution.** No
`Co-Authored-By:` line naming an assistant, no `Claude-Session:` link, no "Generated with" footer.

Enforcement is configured in the harness rather than asserted here. `.claude/settings.json` sets
`attribution` to `{"commit": "", "pr": "", "sessionUrl": false}`, which suppresses all three at the
layer that would otherwise add them, so the default arrives already correct and no session has to
be told.

This file states the repository's policy; it does not claim precedence over a genuine system or
harness instruction, because it has none — a project file is context, not an authority that can
override the runtime. Earlier wording here said it overrode any instruction to the contrary, which
was simply false, and a rule that misdescribes its own force is worse than no rule: it invites a
session to act on an authority that will not hold. If some higher-priority instruction ever does
require a trailer, that instruction wins and this policy has been overridden — say so plainly in
the session rather than silently doing either thing.

Two commits acquired these trailers on 2026-09-04, before the setting existed, and were rewritten
to remove them while still unpushed.

Everything else about commit messages is unchanged: explain what changed and why, and say what the
evidence for it is.
