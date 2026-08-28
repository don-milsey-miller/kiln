import { readStageDocument } from "../../_read/planning.js";
import { compileStageDocument, StageDocumentRejected, compileCount } from "../../_mdx/compile.js";

/**
 * ⚠️ ACC-0020'S INSTRUMENT, silent unless `VPW_BENCH` is set. The protocol's timing boundary starts
 * where the request handler begins the planning-content read — the first line of this component —
 * and ends where the document's markup is complete, which is AFTER this component returns and is
 * therefore not observable from inside it. So this reports the part it can bound exactly (read plus
 * compile, on a monotonic clock) and an absolute wall-clock stamp for the start, letting the
 * harness close the boundary from the other end by watching the markup arrive. Two numbers, each
 * honest about which end it comes from, rather than one number pretending to be the whole span.
 */
const benching = process.env.VPW_BENCH === "1";

/**
 * A stage's document, compiled at request time under the restricted contract — the second of the
 * stage view's two independent reads.
 *
 * ⚠️ THE REJECTION IS CAUGHT HERE, BEFORE IT ESCAPES INTO THE STREAM. AST-0039 measured what happens
 * otherwise: React's production error boundary replaces the compiler's exact diagnostic with an
 * opaque digest, and the response is HTTP 200 because the shell has already streamed. The operator
 * gets a blank region and a success status for a document that was refused precisely. Catching it
 * here is what turns a server-log entry into something on the page (ACC-0036).
 *
 * ⚠️ THE DIAGNOSTIC IS RENDERED AS TEXT, NEVER AS MARKUP. It quotes agent-authored source, so
 * interpolating it would let a refused document inject into the page that reports its refusal —
 * the safety mechanism becoming the delivery route. JSX escapes string children, and that is the
 * mechanism being relied on deliberately rather than incidentally.
 *
 * ⚠️ THE PATH IS REPOSITORY-RELATIVE. The compiler is handed the document's name, not an absolute
 * path, so nothing here can leak where the server keeps its content.
 */
export default async function DocumentPanel({ stageId }) {
  const started = benching ? { wall: Date.now(), mono: performance.now() } : null;
  const doc = await readStageDocument(stageId);
  const readDone = started ? performance.now() : 0;

  if (!doc)
    return (
      <section data-vpw-document="absent" style={{ color: "#666" }}>
        <p>This stage has no document.</p>
      </section>
    );

  const relPath = `planning-content/stages/${doc.name}`;

  let compiled = null;
  let rejection = null;
  try {
    compiled = await compileStageDocument(doc);
  } catch (e) {
    if (!(e instanceof StageDocumentRejected)) throw e;
    rejection = e;
  }

  if (started)
    console.error(
      "vpw-bench " +
        JSON.stringify({
          doc: doc.name,
          bytes: doc.text.length,
          startWall: started.wall,
          readMs: readDone - started.mono,
          compileMs: performance.now() - readDone,
          readAndCompileMs: performance.now() - started.mono,
          compiles: compileCount(),
          rejected: Boolean(rejection),
        })
    );

  if (rejection)
    return (
      <section
        data-vpw-document="rejected"
        style={{
          border: "1px solid #d9a3a3",
          borderLeft: "6px solid #c62828",
          background: "#fdf6f6",
          borderRadius: "4px",
          padding: "15px 18px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontWeight: 600, color: "#a01f1f" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          This stage document was refused
        </div>
        <div
          data-vpw-rejection-at={`${relPath}:${rejection.line ?? "?"}:${rejection.column ?? "?"}`}
          style={{
            background: "#fff",
            border: "1px solid #e8cfcf",
            borderRadius: "4px",
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: ".85rem",
          }}
        >
          <span>{`${relPath}:${rejection.line ?? "?"}:${rejection.column ?? "?"}`}</span>
          <span style={{ color: "#7a2020" }}>{rejection.message}</span>
        </div>
        <span style={{ fontSize: ".84rem", color: "#6b3030" }}>
          Stage documents may use markdown and the permitted components only. Fix the document and this
          page will show it.
        </span>
      </section>
    );

  const { Content, components } = compiled;
  return (
    <section data-vpw-document={doc.name}>
      <Content components={components} />
    </section>
  );
}
