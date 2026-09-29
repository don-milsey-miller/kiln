# Manual authentication evidence history

The current login and OAuth filenames always describe the exact Pi version pinned in `package.json`.
They are never relabelled after a dependency change: the manual protocols must be rerun.

Issue #37 superseded the 0.84.4 observations with fresh 0.87.1 captures on 2026-09-29:

- The earlier OAuth record is retained directly as
  [`oauth/oauth-windows-0.84.4.json`](oauth/oauth-windows-0.84.4.json).
- The four earlier Linux login artifacts remain immutable in Git commit
  `c162b06673c160d07d033e8388749801e0a5dea3`. Their blob IDs are
  `9861e02eb2f48860d2d3398ccd7e820b0dfe9c89`,
  `cf33e214ef359332621a7386f38e124e0a0d9451`,
  `67a3347398a0552f17747088d20139480bc3d26f`, and
  `30c40d7ac0e0d8eb77eaad4478aa38d95abee53e`.

The standard filenames now contain only the 0.87.1 observations. This history exists to preserve
provenance; it does not make the older records evidence for the current pin.
