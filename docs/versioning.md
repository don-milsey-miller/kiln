# Versioning and release policy

Kiln uses Calendar Versioning for official repository releases. The version has the form `YY.M.N`:

| Component | Meaning |
| --- | --- |
| `YY` | Final two digits of the release year. |
| `M` | Calendar month, `1` through `12`, without a leading zero. |
| `N` | Zero-based release sequence within that month. |

The first official release is `26.9.0`: the first Kiln release in September 2026. A second release
in the same month is `26.9.1`; the first release in October 2026 is `26.10.0`.

## Repository representation

- `package.json` and the root package entries in `package-lock.json` carry the version without a
  prefix, for example `26.9.0`.
- The immutable Git tag and GitHub release add a lowercase `v` prefix, for example `v26.9.0`.
- The GitHub release title is `Kiln 26.9.0`.
- A tag identifies the exact `main` commit that passed the release checks.

Although `YY.M.N` is syntactically valid SemVer, its fields have calendar meaning. They do not mean
major, minor, and patch compatibility. Each release must describe material changes, migration needs,
and known limitations in its release notes.

## Release procedure

1. Choose the next version from the release date and that month's existing tags.
2. Update `package.json`, `package-lock.json`, and current-version documentation together.
3. Run the repository's generated-file checks, production audit, and relevant tests.
4. Merge the release change into `main` only after pull-request CI passes.
5. Wait for the `main` merge-commit CI run to pass.
6. Create the immutable `vYY.M.N` tag and GitHub release from that verified `main` commit.

Published tags are not moved or reused. A correction is a new release with the next `N` value.
