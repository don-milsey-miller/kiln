/**
 * Turn raw lint records into the bounded identity surface the review chooser needs.
 *
 * This stays pure so empty, inactive-type and malformed-record cases can be proved without
 * bypassing the server-only reader boundary. A choice must identify the same artifact as its
 * storage path: lint records deliberately retain invalid documents for diagnosis, but the chooser
 * must never offer an identity that a subsequent review request cannot address.
 */
export function artifactReviewChoices(records, activatedTypes) {
  const activeTypes = new Set(activatedTypes ?? []);
  return (records ?? [])
    .filter((record) => {
      const doc = record?.doc;
      return (
        doc &&
        typeof doc.id === "string" &&
        typeof doc.type === "string" &&
        doc.id === record.filenameId &&
        doc.type === record.dirType &&
        activeTypes.has(doc.type) &&
        doc.lifecycle === "active"
      );
    })
    .map(({ doc }) => ({
      id: doc.id,
      type: doc.type,
      title: doc.title ?? "",
      reviewStatus: doc.reviewStatus ?? "draft",
    }))
    .sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * A bounded, searchable review result for the browser. The complete collection may be large, but
 * the page never needs hundreds of native options at once. Filtering stays pure so the server read
 * and the browser journey exercise the same rules.
 */
export function artifactReviewSearch(records, activatedTypes, filters = {}) {
  const all = artifactReviewChoices(records, activatedTypes);
  const query = typeof filters.query === "string" ? filters.query.trim().toLocaleLowerCase() : "";
  const type = typeof filters.type === "string" ? filters.type : "";
  const status = typeof filters.status === "string" ? filters.status : "";
  const requestedLimit = Number.isSafeInteger(filters.limit) ? filters.limit : 50;
  const limit = Math.max(1, Math.min(requestedLimit, 50));
  const types = [...new Set(all.map((candidate) => candidate.type))];
  const statuses = [...new Set(all.map((candidate) => candidate.reviewStatus))];
  const matched = all.filter((candidate) => {
    if (type && candidate.type !== type) return false;
    if (status && candidate.reviewStatus !== status) return false;
    if (!query) return true;
    return candidate.id.toLocaleLowerCase().includes(query) || candidate.title.toLocaleLowerCase().includes(query);
  });
  return {
    items: matched.slice(0, limit),
    total: all.length,
    matched: matched.length,
    truncated: matched.length > limit,
    types,
    statuses,
    filters: { query, type, status },
  };
}
