# Production dependency security

CI runs `npm run audit:production` after the locked install. The command evaluates only production
dependencies and fails on every high or critical advisory. Moderate and lower findings remain visible
in `npm audit --omit=dev` but do not fail this gate.

## Temporary exceptions

The default is to upgrade or constrain the affected dependency. If that cannot be done immediately,
an exception requires all of the following in `.audit-exceptions.json`:

- the exact package, uppercase GHSA identifier, and reported severity;
- a concrete risk-acceptance reason of at least 20 characters;
- `approvedBy` pointing to a repository GitHub issue where the exception is reviewed;
- an expiry no more than 30 days away.

Exceptions match one advisory, not a package range. Expired, malformed, mismatched, duplicate, or
unused exceptions fail CI. Removing the underlying advisory therefore requires removing its exception
in the same change. Renewal is a new reviewed edit to the expiry or issue, not an automatic extension.
