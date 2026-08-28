"use client";

import { useEffect, useState } from "react";
import { createStreamWatchdog, STATE } from "./logic.js";

/**
 * The live/stale indicator — CMP-0017's client half.
 *
 * ⚠️ THE ONLY CLIENT COMPONENT IN THE APPLICATION, and it holds no correctness-critical state.
 * DEC-0023 permits transient interface state and forbids anything a user must not lose; the stream's
 * health is transient by definition, and both selections stay in the URL. `location.reload()` is
 * used rather than an assignment for the same reason — it keeps the URL, and with it the selection.
 *
 * ⚠️ ALL THE LOGIC IS IN `./logic.js`, which takes `EventSource` and its timers as
 * arguments. Everything difficult here is timing — an initial connection is not a reconnection, a
 * heartbeat resets a deadline, a reload must not cause another — and none of that is testable if it
 * lives inside a hook.
 *
 * ⚠️ THE STATE IS TEXT FIRST. AST-0034 measured an idle stream and a dead one as byte-identical, so
 * this indicator is the only thing standing between the operator and a page that looks fine while
 * nothing can refresh it. Colour alone would put that back for anyone who cannot rely on it.
 */

const LOOK = {
  [STATE.LIVE]: { label: "Receiving updates", colour: "#2e7d32" },
  [STATE.CONNECTING]: { label: "Connecting…", colour: "#666" },
  [STATE.STALE]: { label: "Not receiving updates", colour: "#ef6c00" },
};

function Mark({ state }) {
  if (state === STATE.LIVE)
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12l5 5L20 6" />
      </svg>
    );
  if (state === STATE.STALE)
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 8v5" />
        <path d="M12 16.5v.01" />
        <path d="M10.3 3.9L2.4 18a1.9 1.9 0 001.7 2.9h15.8a1.9 1.9 0 001.7-2.9L13.7 3.9a1.9 1.9 0 00-3.4 0z" />
      </svg>
    );
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

export default function StreamWatchdog() {
  const [state, setState] = useState(STATE.CONNECTING);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const wd = createStreamWatchdog({
      EventSourceImpl: EventSource,
      reload: () => location.reload(),
      onState: setState,
    });
    wd.start();
    // ⚠️ The cleanup closes the connection and clears the timer. Without it, a navigation would
    // leave a socket open and a deadline armed against a page that is gone.
    return () => wd.stop();
  }, []);

  const look = LOOK[state] ?? LOOK[STATE.CONNECTING];

  return (
    <span
      data-vpw-stream={state}
      style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: ".8rem", color: look.colour, whiteSpace: "nowrap" }}
    >
      <Mark state={state} />
      {look.label}
    </span>
  );
}
