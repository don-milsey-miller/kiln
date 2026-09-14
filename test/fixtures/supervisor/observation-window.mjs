/**
 * How long a Windows evidence run keeps its trees alive before the agent exits or the interrupt is sent (O9, F119).
 *
 * ⚠️ **ONE POLL INTERVAL FOR THE CHILDREN TO APPEAR AND A LOOK TO START, ONE QUERY TIMEOUT FOR THAT LOOK TO FINISH.**
 * CI measured Windows process-table queries stalling for 3.6 to 7 seconds, against a test agent that lived 3. A
 * query answers or is killed within the process-table timeout, and the tracker's next look starts on the following
 * poll, so this window always holds a finished look while the trees live. The margin covers process start-up.
 * That look captures the agent's identity while it is known alive, which is the only thing that lets an answer
 * arriving after the agent's exit be attributed to it.
 *
 * ⚠️ **IT MAKES THE SCENARIO A NORMAL LONG-RUNNING AGENT, AND CLAIMS NOTHING MORE.** A process that lives for less
 * than this on a Windows host whose process table has stalled may still end before any look completes. POSIX keeps
 * the timing it was measured with, so this returns null there.
 */
import { PROCESS_TABLE_TIMEOUT_MS, TRACK_INTERVAL_MS } from "../../../lib/supervisor.mjs";

export const OBSERVATION_MARGIN_MS = 1000;

export const firstLookWindowMs = (platform = process.platform) =>
  platform === "win32" ? TRACK_INTERVAL_MS.win32 + PROCESS_TABLE_TIMEOUT_MS + OBSERVATION_MARGIN_MS : null;
