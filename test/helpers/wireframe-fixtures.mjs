/**
 * Synthetic wireframe records for #188, shared by the projection tests and the browser test.
 *
 * ⚠️ **SHAPED LIKE THE REPORTED ARTIFACTS, WITH NONE OF THEIR CONTENT.** The five wireframes the issue was reported
 * against have a 1280-wide viewport, five or six top-level regions, ten to thirteen components directly inside
 * them, three to five annotations, and every `bounds` in viewport coordinates. `FIVE` reproduces that shape for an
 * invented library-lending application. Its trace ids are whatever the caller passes, so a test names artifacts
 * that exist in the project it serves.
 */

export const envelope = (id, title, body, { schemaVersion = 1 } = {}) => ({
  id,
  type: "wireframe",
  schemaVersion,
  reviewStatus: "draft",
  lifecycle: "active",
  title,
  ...body,
});

export const bounds = (x, y, width, height) => ({ x, y, width, height });
export const region = (id, kind, label, at, { components, regions } = {}) => ({
  id,
  kind,
  label,
  bounds: bounds(...at),
  ...(components ? { components } : {}),
  ...(regions ? { regions } : {}),
});
export const component = (id, kind, label, at, content) => ({ id, kind, label, ...(content === undefined ? {} : { content }), bounds: bounds(...at) });

/**
 * One screen: a full-width first row, then inset rows stacked beneath it, each row's components laid side by side
 * inside it. Every coordinate is measured from the viewport's top-left corner.
 */
function screen({ rows, width = 1280 }) {
  let y = 0;
  return rows.map(({ id, kind, label, height, components }, index) => {
    const at = index === 0 ? [0, 0, width, height] : [24, y, width - 48, height];
    const gap = 20;
    const inner = { x: at[0] + 16, y: at[1] + 16, width: at[2] - 32, height: height - 32 };
    const each = Math.floor((inner.width - gap * (components.length - 1)) / components.length);
    y = at[1] + height + 24;
    return region(id, kind, label, at, {
      components: components.map(([cid, ckind, clabel, content], i) => component(cid, ckind, clabel, [inner.x + i * (each + gap), inner.y, each, inner.height], content)),
    });
  });
}

/**
 * @param {{requirements: string[], decisions: string[], schemaVersion?: number}} ids  at least four requirement ids
 *   and two decision ids that exist in the project the wireframes will be read in
 */
export function fiveWireframes({ requirements: R, decisions: D, schemaVersion }) {
  const make = (n, title, summary, body) => envelope(`WIR-000${n}`, title, { summary, ...body }, { schemaVersion });
  return [
    make(1, "Catalogue overview", "Search the catalogue and see what is on loan.", {
      viewport: { width: 1280, height: 900 },
      regions: screen({
        rows: [
          { id: "navigation", kind: "navigation", label: "Branch navigation", height: 72, components: [["branch-switch", "select", "Current branch", "Only branches the member belongs to."], ["main-links", "links", "Catalogue, Loans, Holds, Account"]] },
          { id: "totals", kind: "summary", label: "Loan and hold totals", height: 120, components: [["on-loan", "statistic", "Items on loan", "Count with a text label, not colour alone."], ["due-soon", "statistic", "Due in the next seven days", "Count and the earliest due date."], ["holds-ready", "statistic", "Holds ready to collect"]] },
          { id: "filters", kind: "form", label: "Catalogue filters", height: 72, components: [["search", "input", "Search by title or author"], ["format-filter", "select", "Format", "Book, audiobook, film."]] },
          { id: "results", kind: "main", label: "Matching items", height: 440, components: [["results-table", "table", "Title, author, format, availability", "Sortable columns. Each row links to the item."], ["results-pager", "controls", "Previous and next page"]] },
          { id: "status", kind: "status", label: "Search status", height: 64, components: [["result-count", "live-region", "Number of matching items", "Announced after each search."], ["export", "action", "Export results"]] },
        ],
      }),
      annotations: [
        { id: "note-totals", target: "totals", note: "Totals are for the current branch only.", requirements: [R[0], R[1]] },
        { id: "note-search", target: "search", note: "Search runs on submit, not on every key.", requirements: [R[2]] },
        { id: "note-count", target: "result-count", note: "The count is announced to a screen reader.", requirements: [R[3]] },
      ],
      implements: [R[0], R[1], R[2], R[3]],
    }),
    make(2, "Item detail and hold request", "One item, its copies, and the form that places a hold.", {
      viewport: { width: 1280, height: 900 },
      regions: screen({
        rows: [
          { id: "header", kind: "header", label: "Item heading", height: 72, components: [["back-link", "link", "Back to results"], ["item-title", "heading", "Item title and author"]] },
          { id: "errors", kind: "error-summary", label: "Problems with this request", height: 64, components: [["error-list", "alert", "Each problem links to its field", "Shown only when a request was refused."]] },
          { id: "copies", kind: "section", label: "Copies and availability", height: 240, components: [["copy-table", "table", "Branch, shelf mark, status", "A copy on loan shows its due date."], ["availability-note", "text", "When the next copy is expected"]] },
          { id: "hold-form", kind: "form", label: "Place a hold", height: 200, components: [["pickup-branch", "select", "Collect from", "Defaults to the current branch."], ["notify-by", "inputs", "How to be told it is ready", "Email or text message."], ["hold-until", "input", "Not needed after"]] },
          { id: "actions", kind: "controls", label: "Request actions", height: 72, components: [["place-hold", "button", "Place hold"], ["cancel", "button", "Cancel"]] },
          { id: "feedback", kind: "feedback", label: "Request outcome", height: 64, components: [["outcome", "live-region", "Hold placed or refused", "States the queue position."], ["queue-help", "text", "How the queue works"], ["contact", "link", "Ask a librarian"]] },
        ],
      }),
      annotations: [
        { id: "note-errors", target: "errors", note: "Focus moves here after a refused request.", requirements: [R[1], R[2]] },
        { id: "note-pickup", target: "pickup-branch", note: "Only branches that lend this format are listed.", requirements: [R[0]] },
        { id: "note-outcome", target: "outcome", note: "The outcome is never colour alone.", requirements: [R[3]] },
      ],
      implements: [R[0], R[1], R[2], R[3]],
      decidedBy: [D[0]],
    }),
    make(3, "Loans and renewals", "Everything a member has on loan, with renewal.", {
      viewport: { width: 1280, height: 900 },
      regions: screen({
        rows: [
          { id: "header", kind: "header", label: "Loans heading", height: 72, components: [["page-title", "heading", "Your loans"], ["member-card", "text", "Card number and expiry"]] },
          { id: "overdue", kind: "section", label: "Overdue items", height: 160, components: [["overdue-list", "list", "Title, due date, days overdue", "Listed first and marked with the word Overdue."], ["overdue-help", "text", "What happens when an item is overdue"]] },
          { id: "current", kind: "section", label: "Current loans", height: 320, components: [["loan-table", "table", "Title, due date, renewals left", "A checkbox per row selects it for renewal."], ["select-all", "controls", "Select every renewable loan"]] },
          { id: "renewal", kind: "controls", label: "Renewal actions", height: 72, components: [["renew-selected", "button", "Renew selected"], ["renew-status", "status", "Which renewals succeeded", "Each refusal says why."]] },
          { id: "history", kind: "section", label: "Returned in the last 90 days", height: 120, components: [["history-list", "list", "Title and return date"], ["history-export", "button", "Download history"], ["history-clear", "button", "Clear history", "Asks for confirmation first."]] },
        ],
      }),
      annotations: [
        { id: "note-overdue", target: "overdue-list", note: "Overdue is stated in words.", requirements: [R[3]] },
        { id: "note-renewals", target: "loan-table", note: "A loan with a hold on it cannot be renewed.", requirements: [R[0], R[1]] },
        { id: "note-status", target: "renew-status", note: "Partial success is reported per item.", requirements: [R[2]] },
        { id: "note-history", target: "history", note: "History is kept for 90 days.", requirements: [R[1]] },
      ],
      implements: [R[0], R[1], R[2]],
      decidedBy: [D[1]],
    }),
    make(4, "Holds and pickup", "Holds waiting, ready and expired.", {
      viewport: { width: 1280, height: 900 },
      regions: screen({
        rows: [
          { id: "header", kind: "header", label: "Holds heading", height: 72, components: [["page-title", "heading", "Your holds"], ["pickup-default", "select", "Default pickup branch"]] },
          { id: "ready", kind: "section", label: "Ready to collect", height: 180, components: [["ready-list", "list", "Title, branch, collect by", "The collect-by date is in full."], ["directions", "link", "Branch opening hours"]] },
          { id: "waiting", kind: "section", label: "In the queue", height: 240, components: [["queue-table", "table", "Title, position, estimated wait"], ["pause", "buttons", "Pause or resume a hold", "A paused hold keeps its position."]] },
          { id: "expired", kind: "section", label: "Expired or cancelled", height: 120, components: [["expired-list", "definition-list", "Title and reason"], ["request-again", "button", "Request again"]] },
          { id: "settings", kind: "form", label: "Notification settings", height: 96, components: [["notify-inputs", "inputs", "Email and text message", "At least one is required."], ["save-settings", "button", "Save"]] },
          { id: "feedback", kind: "status", label: "Change outcome", height: 64, components: [["change-status", "status", "What changed", "Announced after each action."], ["undo", "button", "Undo"], ["help", "link", "Help with holds"]] },
        ],
      }),
      annotations: [
        { id: "note-ready", target: "ready-list", note: "Ready holds are listed before everything else.", requirements: [R[0]] },
        { id: "note-pause", target: "pause", note: "Pausing does not lose the queue position.", requirements: [R[1], R[2]] },
        { id: "note-notify", target: "notify-inputs", note: "A member cannot remove their only contact method.", requirements: [R[2]] },
        { id: "note-undo", target: "undo", note: "Undo is offered for ten seconds.", requirements: [R[3]] },
      ],
      implements: [R[0], R[1], R[2], R[3]],
      decidedBy: [D[0], D[1]],
    }),
    make(5, "Branch administration", "Opening hours, closures and bulk catalogue imports.", {
      viewport: { width: 1280, height: 1000 },
      regions: screen({
        rows: [
          { id: "tabs", kind: "navigation", label: "Administration sections", height: 72, components: [["section-tabs", "tabs", "Hours, Closures, Imports, Staff", "The current tab is named as current."]] },
          { id: "hours", kind: "form", label: "Opening hours", height: 200, components: [["hours-inputs", "inputs", "Open and close time for each day", "A closed day is a checkbox, not an empty time."], ["hours-save", "buttons", "Save or discard", "Discard asks for confirmation."]] },
          { id: "closures", kind: "section", label: "Planned closures", height: 180, components: [["closure-table", "table", "Date, reason, who added it", "Due dates move past a closure."], ["closure-add", "form", "Add a closure", "Date and reason are both required."]] },
          { id: "imports", kind: "section", label: "Catalogue imports", height: 200, components: [["import-file", "file-input", "Choose a file to import", "CSV, at most 10,000 rows."], ["import-jobs", "table", "File, rows, status, started", "A failed job links to its error report."]] },
          { id: "confirm", kind: "confirmation", label: "Confirm a destructive change", height: 96, components: [["confirm-text", "status", "What will be removed", "Names the count and the branch."], ["confirm-buttons", "buttons", "Confirm or cancel", "Cancel is the default."]] },
          { id: "audit", kind: "status", label: "Recent changes", height: 96, components: [["audit-list", "table", "Who changed what, and when", "Read-only."]] },
        ],
      }),
      annotations: [
        { id: "note-tabs", target: "section-tabs", note: "Tabs are links, so each section has an address.", requirements: [R[0]] },
        { id: "note-closed", target: "hours-inputs", note: "Closed is explicit.", requirements: [R[1]] },
        { id: "note-due", target: "closure-table", note: "A closure never makes an item overdue.", requirements: [R[1], R[2]] },
        { id: "note-import", target: "import-jobs", note: "An import can be read while it runs.", requirements: [R[2], R[3]] },
        { id: "note-confirm", target: "confirm", note: "Nothing is removed without this step.", requirements: [R[3]] },
      ],
      implements: [R[0], R[1], R[2], R[3]],
      decidedBy: [D[0], D[1]],
    }),
  ];
}
