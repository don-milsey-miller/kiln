"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The interactive view of one wireframe (#188): an SVG drawing and a nested list of the same elements.
 *
 * ⚠️ IT OWNS VIEW STATE AND NOTHING ELSE. Zoom, position and the selected element live in this component's memory.
 * Nothing here fetches, calls a server action, touches browser storage, or changes the address. A trace link is a
 * plain link to the review route. So no interaction can reach the artifact, and a reload starts again from the
 * record.
 *
 * ⚠️ IT IS GIVEN A PROJECTION, NEVER A RECORD. `view` is what `projectWireframe` returned for a record that passed
 * its schema. Every string in it is rendered as text.
 *
 * ⚠️ 100% IS THE DECLARED VIEWPORT, NOT ONE UNIT PER PIXEL. The view is an SVG `viewBox` in the wireframe's own
 * units and the drawing scales to whatever width the page gives it. So the first render, Reset and Fit are the same
 * on the server and in every browser, and none of them measures anything.
 *
 * ⚠️ THE LIST IS THE ACCESSIBLE FORM, AND THE ONLY WAY TO A COVERED ELEMENT. The drawing is hidden from assistive
 * technology and a click on it selects the topmost element under the pointer. Every element has a button in the
 * list, which shows its full label, kind, bounds, content and annotations without a hover.
 *
 * ⚠️ THE LOWEST ZOOM IS `min(25%, fitZoom)`. `fitZoom` is the zoom at which the viewport and every element are in
 * view together. It is 100% when nothing lies outside the viewport and falls as elements lie further out. Zooming
 * out stops at 25%, unless Fit needs less than that, and then it stops where Fit does. So Fit always shows
 * everything, and nothing can be zoomed out further than Fit when Fit is already below 25%.
 *
 * Nothing is animated, so there is nothing to turn off for a reader who prefers reduced motion.
 */

const ZOOM_STEP = 1.25;
const ZOOM_MAX = 8;
/** The floor for zooming out, as a fraction of the declared viewport. The effective floor is `min(ZOOM_MIN, fitZoom)`. */
const ZOOM_MIN = 0.25;
/** How far a pointer may move, in CSS pixels, and still be a click rather than a drag. */
const DRAG_THRESHOLD = 4;

const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const number = (n) => String(Math.round(n * 100) / 100);

const button = { padding: ".3rem .6rem", fontSize: ".82rem", cursor: "pointer", minWidth: "2.2rem" };
const muted = { color: "#666", fontSize: ".78rem" };
const code = { background: "#f6f6f6", padding: "0 .25rem", borderRadius: "3px", overflowWrap: "anywhere" };

function TraceLinks({ links, stageId }) {
  if (links.length === 0) return <span style={muted}>none</span>;
  return (
    <span style={{ display: "inline-flex", gap: "8px", flexWrap: "wrap" }}>
      {links.map((link, i) =>
        link.resolved ? (
          <a key={i} data-wf-trace={link.id} href={`/stage/${stageId}?artifact=${link.id}`}>
            {link.id}
          </a>
        ) : (
          <span key={i} data-wf-trace-unresolved={link.id}>
            <code style={code}>{link.id}</code> <span style={muted}>(not in this project)</span>
          </span>
        )
      )}
    </span>
  );
}

function Annotation({ annotation, stageId }) {
  return (
    <div data-wf-annotation={annotation.key} style={{ borderLeft: "3px solid #8a6d1a", paddingLeft: "8px", display: "flex", flexDirection: "column", gap: "2px" }}>
      <div>
        <span style={{ fontWeight: 600 }}>Annotation {annotation.number}</span> <code style={code}>{annotation.id}</code>
      </div>
      <div style={{ overflowWrap: "anywhere" }}>{annotation.note}</div>
      <div>
        <span style={muted}>requirements </span>
        <TraceLinks links={annotation.requirements} stageId={stageId} />
      </div>
    </div>
  );
}

/** Everything the record says about one element. The list and the selection panel both render this. */
function ElementDetails({ element, annotations, stageId }) {
  const { x, y, width, height } = element.bounds;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: ".82rem", minWidth: 0 }}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "baseline" }}>
        <span>
          {element.role} · kind <code style={code}>{element.kind}</code>
        </span>
        <span>
          id <code style={code}>{element.id}</code>
          {element.duplicateId ? <span style={{ color: "#8a4b00" }}> (declared more than once)</span> : null}
        </span>
      </div>
      <div data-wf-bounds={element.key} style={muted}>
        x {number(x)}, y {number(y)}, width {number(width)}, height {number(height)}
      </div>
      {element.content === null ? null : (
        <div data-wf-content={element.key} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {element.content}
        </div>
      )}
      {element.annotations.map((n) => (
        <Annotation key={n} annotation={annotations[n - 1]} stageId={stageId} />
      ))}
    </div>
  );
}

function ElementList({ parentKey, tree, annotations, selected, onSelect, stageId }) {
  const here = tree.get(parentKey) ?? [];
  if (here.length === 0) return null;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: parentKey === null ? 0 : "0 0 0 14px", display: "flex", flexDirection: "column", gap: "8px", borderLeft: parentKey === null ? "none" : "1px solid #ddd" }}>
      {here.map((element) => {
        const isSelected = element.key === selected;
        return (
          <li key={element.key} data-wf-entry={element.key} style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 }}>
            <div style={{ border: isSelected ? "2px solid #111" : "1px solid #ddd", borderRadius: "4px", padding: isSelected ? "7px" : "8px", display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
              <button
                type="button"
                data-wf-item={element.key}
                aria-current={isSelected ? "true" : undefined}
                onClick={() => onSelect(element.key)}
                style={{ textAlign: "left", font: "inherit", fontWeight: 600, fontSize: ".86rem", background: "none", border: "none", padding: 0, cursor: "pointer", overflowWrap: "anywhere", textDecoration: "underline" }}
              >
                {element.label}
                {isSelected ? " (selected)" : ""}
              </button>
              <ElementDetails element={element} annotations={annotations} stageId={stageId} />
            </div>
            <ElementList parentKey={element.key} tree={tree} annotations={annotations} selected={selected} onSelect={onSelect} stageId={stageId} />
          </li>
        );
      })}
    </ul>
  );
}

export default function WireframeViewer({ view, stageId }) {
  const { viewport, extent, elements, annotations } = view;
  const home = { zoom: 1, cx: viewport.width / 2, cy: viewport.height / 2 };
  const fitZoom = Math.min(viewport.width / extent.width, viewport.height / extent.height);
  const fitted = { zoom: fitZoom, cx: extent.x + extent.width / 2, cy: extent.y + extent.height / 2 };
  const minZoom = Math.min(ZOOM_MIN, fitZoom);

  const [camera, setCamera] = useState(home);
  const [selected, setSelected] = useState(null);
  const svgRef = useRef(null);
  const drag = useRef(null);

  /** The position is kept inside what is drawn, so the drawing can never be lost off the edge. */
  const settle = ({ zoom, cx, cy }) => ({
    zoom: clamp(zoom, minZoom, ZOOM_MAX),
    cx: clamp(cx, extent.x, extent.x + extent.width),
    cy: clamp(cy, extent.y, extent.y + extent.height),
  });
  /** Zoom by `factor`, keeping the point `about` (in wireframe units) where it is on the screen. */
  const zoomBy = (factor, about) =>
    setCamera((c) => {
      const zoom = clamp(c.zoom * factor, minZoom, ZOOM_MAX);
      const at = about ?? { x: c.cx, y: c.cy };
      const ratio = c.zoom / zoom;
      return settle({ zoom, cx: at.x + (c.cx - at.x) * ratio, cy: at.y + (c.cy - at.y) * ratio });
    });
  /** Move by a fraction of what is visible. */
  const panBy = (dx, dy) => setCamera((c) => settle({ ...c, cx: c.cx + (dx * viewport.width) / c.zoom, cy: c.cy + (dy * viewport.height) / c.zoom }));
  const reset = () => {
    setCamera(home);
    setSelected(null);
  };
  const fit = () => setCamera(fitted);

  const width = viewport.width / camera.zoom;
  const height = viewport.height / camera.zoom;
  const viewBox = `${number(camera.cx - width / 2)} ${number(camera.cy - height / 2)} ${number(width)} ${number(height)}`;

  // ⚠️ Ctrl+wheel and a touchpad pinch zoom. A plain wheel is left alone, so the page still scrolls under the pointer.
  // The listener is added by hand because it has to be able to cancel the browser's own zoom, and React's cannot.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const matrix = svg.getScreenCTM();
      const about = matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
      zoomBy(Math.exp(-event.deltaY * 0.0022), about ? { x: about.x, y: about.y } : undefined);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, key: event.target.closest?.("[data-wf-key]")?.getAttribute("data-wf-key") ?? null };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    d.x = event.clientX;
    d.y = event.clientY;
    const scale = svgRef.current?.getScreenCTM()?.a || 1;
    setCamera((c) => settle({ ...c, cx: c.cx - dx / scale, cy: c.cy - dy / scale }));
  };
  const onPointerUp = (event) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (!d.moved && d.key) setSelected(d.key);
  };

  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const actions = {
      ArrowLeft: () => panBy(-0.1, 0),
      ArrowRight: () => panBy(0.1, 0),
      ArrowUp: () => panBy(0, -0.1),
      ArrowDown: () => panBy(0, 0.1),
      "+": () => zoomBy(ZOOM_STEP),
      "=": () => zoomBy(ZOOM_STEP),
      "-": () => zoomBy(1 / ZOOM_STEP),
      0: reset,
      f: fit,
      F: fit,
      Escape: () => setSelected(null),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const tree = new Map();
  for (const element of elements) tree.set(element.parentKey, [...(tree.get(element.parentKey) ?? []), element]);
  const chosen = elements.find((element) => element.key === selected) ?? null;
  const unattached = annotations.filter((annotation) => annotation.targetKey === null);
  // Text and badges are sized in the wireframe's own units, so they keep their proportion to the boxes.
  const unit = viewport.width / 100;
  const controls = [
    ["zoom-in", "Zoom in", "+", () => zoomBy(ZOOM_STEP)],
    ["zoom-out", "Zoom out", "−", () => zoomBy(1 / ZOOM_STEP)],
    ["pan-left", "Pan left", "←", () => panBy(-0.1, 0)],
    ["pan-right", "Pan right", "→", () => panBy(0.1, 0)],
    ["pan-up", "Pan up", "↑", () => panBy(0, -0.1)],
    ["pan-down", "Pan down", "↓", () => panBy(0, 0.1)],
    ["reset", "Reset view and clear selection", "Reset", reset],
    ["fit", "Fit everything in view", "Fit", fit],
  ];

  return (
    <div data-wf-viewer={view.id} style={{ borderTop: "1px solid #eee", paddingTop: "12px", display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
      <div style={{ fontWeight: 600, fontSize: ".85rem" }}>
        Wireframe · {number(viewport.width)} × {number(viewport.height)} · {elements.length} element{elements.length === 1 ? "" : "s"} · {annotations.length} annotation{annotations.length === 1 ? "" : "s"}
      </div>

      {view.warnings.length > 0 ? (
        <div data-wf-warnings={view.warnings.length} role="status" style={{ border: "1px solid #d8cfa8", background: "#fdfaf2", borderRadius: "4px", padding: "9px 12px", fontSize: ".8rem" }}>
          <div style={{ fontWeight: 600 }}>This wireframe is drawn as written. Check these:</div>
          <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
            {view.warnings.map((warning, i) => (
              <li key={i} data-wf-warning={warning.code} style={{ overflowWrap: "anywhere" }}>
                {warning.severity} <code style={code}>{warning.code}</code> {warning.message}
              </li>
            ))}
          </ul>
          {view.omittedWarnings > 0 ? <div style={{ marginTop: "6px" }}>{view.omittedWarnings} more not shown.</div> : null}
        </div>
      ) : null}

      <div role="group" aria-label="Wireframe view controls" style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
        {controls.map(([id, label, text, run]) => (
          <button key={id} type="button" data-wf-control={id} aria-label={label} title={label} onClick={run} style={button}>
            {text}
          </button>
        ))}
        <output data-wf-zoom={number(camera.zoom * 100)} style={{ fontSize: ".82rem", color: "#444" }}>
          Zoom {Math.round(camera.zoom * 100)}%
        </output>
      </div>

      <div
        data-wf-canvas
        tabIndex={0}
        role="group"
        aria-label={`Drawing of ${view.title || view.id}. Arrow keys pan, plus and minus zoom, 0 resets, F fits, Escape clears the selection. The list below has every element.`}
        onKeyDown={onKeyDown}
        style={{ border: "1px solid #bbb", borderRadius: "4px", background: "#e9e9e9", lineHeight: 0, minWidth: 0 }}
      >
        <svg
          ref={svgRef}
          aria-hidden="true"
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          style={{ display: "block", width: "100%", aspectRatio: `${viewport.width} / ${viewport.height}`, maxHeight: "36rem", touchAction: "none", cursor: "grab", userSelect: "none" }}
        >
          <rect data-wf-frame x={0} y={0} width={viewport.width} height={viewport.height} fill="#fff" stroke="#999" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {elements.map((element) => {
            const { x, y, width: w, height: h } = element.bounds;
            const isSelected = element.key === selected;
            const region = element.role === "region";
            return (
              <g key={element.key} data-wf-key={element.key} data-wf-role={element.role} data-wf-selected={isSelected ? "true" : undefined}>
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  fill={region ? "#f4f6f8" : "#fff"}
                  fillOpacity={region ? 0.55 : 0.9}
                  stroke={isSelected ? "#000" : region ? "#5a6b7b" : "#333"}
                  strokeWidth={isSelected ? 4 : 1}
                  strokeDasharray={region ? "6 4" : undefined}
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="all"
                />
                <svg x={x} y={y} width={w} height={h} overflow="hidden" pointerEvents="none">
                  {/* A region's label is smaller and sits against its top edge, above where its components usually start. */}
                  <text x={unit * 0.5} y={unit * (region ? 0.95 : 1.5)} fontSize={unit * (region ? 0.85 : 1.15)} fontFamily="system-ui, sans-serif" fontWeight={region ? 600 : 400} fill="#111">
                    {element.label}
                  </text>
                </svg>
              </g>
            );
          })}
          {/* Drawn last, so an annotation's number is never under the elements inside its target. */}
          {elements.flatMap((element) =>
            element.annotations.map((n, i) => {
              const cx = element.bounds.x + element.bounds.width - unit * (1.2 + i * 2.2);
              const cy = element.bounds.y + unit * 1.2;
              return (
                <g key={`${element.key}:${n}`} data-wf-badge={n} data-wf-badge-for={element.key} pointerEvents="none">
                  <circle cx={cx} cy={cy} r={unit} fill="#fff" stroke="#8a6d1a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  <text x={cx} y={cy + unit * 0.4} fontSize={unit * 1.1} textAnchor="middle" fontFamily="system-ui, sans-serif" fontWeight={700} fill="#5c4708">
                    {n}
                  </text>
                </g>
              );
            })
          )}
        </svg>
      </div>
      <div style={muted}>
        Regions have a dashed outline and components a solid one. A numbered circle marks an annotation. Drag to pan. Hold Ctrl and scroll, or pinch, to zoom.
      </div>

      <div data-wf-selection={chosen ? chosen.key : ""} aria-live="polite" style={{ border: "1px solid #ddd", borderRadius: "4px", padding: "9px 12px", display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
        <div style={{ ...muted, textTransform: "uppercase", letterSpacing: ".04em" }}>Selected element</div>
        {chosen ? (
          <>
            <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{chosen.label}</div>
            <ElementDetails element={chosen} annotations={annotations} stageId={stageId} />
          </>
        ) : (
          <div style={muted}>None. Choose an element in the drawing or in the list.</div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 }}>
        <div id={`wf-list-${view.id}`} style={{ fontWeight: 600, fontSize: ".85rem" }}>
          Regions and components
        </div>
        <div role="group" aria-labelledby={`wf-list-${view.id}`} data-wf-list>
          <ElementList parentKey={null} tree={tree} annotations={annotations} selected={selected} onSelect={setSelected} stageId={stageId} />
        </div>
      </div>

      {unattached.length > 0 ? (
        <div data-wf-unattached={unattached.length} style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: ".82rem", minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: ".85rem" }}>Annotations not attached to an element</div>
          {unattached.map((annotation) => (
            <div key={annotation.key} style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
              <Annotation annotation={annotation} stageId={stageId} />
              <div style={{ ...muted, overflowWrap: "anywhere" }}>
                target <code style={code}>{annotation.target}</code> {annotation.targetProblem === "ambiguous" ? "is declared by more than one element" : "is not declared by any element"}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <dl data-wf-traces style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: "4px 12px", fontSize: ".82rem" }}>
        <dt style={muted}>implements</dt>
        <dd style={{ margin: 0 }}>
          <TraceLinks links={view.traces.implements} stageId={stageId} />
        </dd>
        <dt style={muted}>decided by</dt>
        <dd style={{ margin: 0 }}>
          <TraceLinks links={view.traces.decidedBy} stageId={stageId} />
        </dd>
        <dt style={muted}>open questions</dt>
        <dd style={{ margin: 0 }}>
          <TraceLinks links={view.traces.openQuestions} stageId={stageId} />
        </dd>
      </dl>
    </div>
  );
}
