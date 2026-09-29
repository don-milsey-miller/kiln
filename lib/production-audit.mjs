const SEVERITY = Object.freeze({ info: 0, low: 1, moderate: 2, high: 3, critical: 4 });
const GHSA_URL = /^https:\/\/github\.com\/advisories\/(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})$/i;
const ISSUE_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9][0-9]*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const day = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
};

function findingsFor(report) {
  const found = new Map();
  const vulnerabilities = report?.vulnerabilities ?? {};

  const visit = (packageName, visiting = new Set()) => {
    if (visiting.has(packageName)) return false;
    const vulnerability = vulnerabilities[packageName];
    if ((SEVERITY[vulnerability?.severity] ?? -1) < SEVERITY.high) return false;
    const next = new Set(visiting).add(packageName);
    let resolved = false;
    for (const via of vulnerability?.via ?? []) {
      if (typeof via === "string") {
        resolved = visit(via, next) || resolved;
        continue;
      }
      if (via === null || typeof via !== "object" || (SEVERITY[via.severity] ?? -1) < SEVERITY.high) continue;
      const advisory = GHSA_URL.exec(via.url ?? "")?.[1]?.toUpperCase();
      if (!advisory) continue;
      resolved = true;
      const affected = via.dependency ?? via.name ?? packageName;
      const key = `${affected}\0${advisory}`;
      found.set(key, { package: affected, advisory, severity: via.severity, title: via.title ?? advisory, url: via.url });
    }
    if (!resolved) {
      const advisory = `UNRESOLVED-${packageName}`;
      found.set(`${packageName}\0${advisory}`, {
        package: packageName,
        advisory,
        severity: vulnerability.severity,
        title: "npm reported a high/critical dependency without a concrete advisory",
        url: null,
      });
    }
    return resolved;
  };

  for (const packageName of Object.keys(vulnerabilities)) {
    const vulnerability = vulnerabilities[packageName];
    if ((SEVERITY[vulnerability?.severity] ?? -1) < SEVERITY.high) continue;
    visit(packageName);
  }
  return [...found.values()].sort(
    (a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.package.localeCompare(b.package) || a.advisory.localeCompare(b.advisory)
  );
}

function validateExceptions(document, now) {
  const errors = [];
  if (document?.schemaVersion !== 1) errors.push("audit exceptions must declare schemaVersion 1");
  if (!Array.isArray(document?.exceptions)) return { exceptions: [], errors: [...errors, "audit exceptions must contain an exceptions array"] };

  const seen = new Set();
  const exceptions = [];
  for (const [index, entry] of document.exceptions.entries()) {
    const at = `exceptions[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => !["package", "advisory", "severity", "expires", "reason", "approvedBy"].includes(key));
    if (unknown.length) errors.push(`${at} has unknown field(s): ${unknown.join(", ")}`);
    const key = `${entry.package}\0${entry.advisory}`;
    if (seen.has(key)) errors.push(`${at} duplicates ${entry.package}/${entry.advisory}`);
    seen.add(key);
    if (typeof entry.package !== "string" || entry.package.length === 0) errors.push(`${at}.package must be non-empty`);
    if (!/^GHSA-[23456789CFGHJMPQRVWX]{4}-[23456789CFGHJMPQRVWX]{4}-[23456789CFGHJMPQRVWX]{4}$/.test(entry.advisory ?? ""))
      errors.push(`${at}.advisory must be an uppercase GHSA id`);
    if (!new Set(["high", "critical"]).has(entry.severity)) errors.push(`${at}.severity must be high or critical`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) errors.push(`${at}.reason must explain the temporary risk acceptance`);
    if (typeof entry.approvedBy !== "string" || !ISSUE_URL.test(entry.approvedBy)) errors.push(`${at}.approvedBy must be a GitHub issue URL`);
    const expires = day(entry.expires);
    if (!expires) errors.push(`${at}.expires must be a real YYYY-MM-DD date`);
    else {
      const remaining = Math.floor((expires.valueOf() - now.valueOf()) / DAY_MS);
      if (remaining < 0) errors.push(`${at} expired on ${entry.expires}`);
      if (remaining > 30) errors.push(`${at}.expires is more than 30 days away; exceptions are temporary`);
    }
    exceptions.push(entry);
  }
  return { exceptions, errors };
}

/** Judge npm's production audit against narrow, expiring, issue-backed exceptions. */
export function evaluateProductionAudit(report, exceptionDocument, { now = new Date() } = {}) {
  const normalizedNow = day(now.toISOString().slice(0, 10));
  const findings = findingsFor(report);
  const checked = validateExceptions(exceptionDocument, normalizedNow);
  const used = new Set();
  const blocked = [];

  for (const finding of findings) {
    const index = checked.exceptions.findIndex(
      (entry) => entry.package === finding.package && entry.advisory === finding.advisory && entry.severity === finding.severity
    );
    if (index === -1) blocked.push(finding);
    else used.add(index);
  }
  for (const [index, entry] of checked.exceptions.entries())
    if (!used.has(index)) checked.errors.push(`unused exception ${entry.package}/${entry.advisory} must be removed or corrected`);

  return { ok: blocked.length === 0 && checked.errors.length === 0, findings, blocked, excepted: [...used].map((index) => checked.exceptions[index]), errors: checked.errors };
}
