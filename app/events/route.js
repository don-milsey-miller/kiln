import { createChangeStream, EVENTS } from "../server/change-stream.js";
import { resolveContentRoot } from "../server/paths.js";

/**
 * `/events` — the change stream as `text/event-stream`.
 *
 * ⚠️ THE SERVICE IS CREATED LAZILY, ON THE FIRST REQUEST, and shared by every subsequent one. Creating
 * it at module scope would start a watcher during `next build`, when this module is imported to
 * collect route data.
 *
 * ⚠️ THE WATCHED DIRECTORY COMES FROM THE SHARED RESOLVER, not from a fallback of this route's own.
 * It used to be `${PLANNING_CONTENT_DIR ?? cwd()/planning-content}/data`, which in a consumer install
 * resolves to the TOOL's own shipped content — so the page would read the project while the watcher
 * watched Kiln's history, and every save would look like it had not taken effect. Two independent
 * answers to "where is the content" is #70's failure, and a watcher is the worst place for it because
 * watching the wrong directory reports nothing rather than reporting an error.
 *
 * ⚠️ EVERY FRAME IS A NAMED EVENT. A comment keepalive is ignored by the client parser (AST-0036), so
 * it would keep the socket warm and fire nothing — leaving a page that cannot tell a healthy stream
 * from a dead one, which is exactly REQ-0018's second clause.
 *
 * ⚠️ THE SUBSCRIBER IS REMOVED WHEN THE REQUEST ABORTS, not when the process notices later. Its
 * heartbeat timer goes with it; the shared watcher does not, so one closed tab cannot stop another
 * page refreshing.
 */
export const dynamic = "force-dynamic";

let service = null;

function get() {
  if (!service)
    service = createChangeStream({
      watchDir: `${resolveContentRoot(process.env)}/data`,
      heartbeatMs: Number(process.env.VPW_HEARTBEAT_MS ?? 5000),
    });
  return service;
}

export async function GET(request) {
  const stream = get();
  const encoder = new TextEncoder();

  let unsubscribe = null;
  const body = new ReadableStream({
    async start(controller) {
      let live = true;
      const write = (chunk) => {
        if (!live) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          live = false;
        }
      };

      const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const close = () => {
        if (!live) return;
        live = false;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // The reconnection interval. No `id:` field: events are hints, so there is nothing to resume.
      write("retry: 1000\n\n");

      unsubscribe = await stream.subscribe({ send, close });
      // One immediately, so a client knows the stream is alive without waiting a whole interval.
      send(EVENTS.HEARTBEAT, { ok: true });

      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        close();
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
