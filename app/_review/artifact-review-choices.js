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
