import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Content scripts receive invalidations over a plugin-owned, local-auth SSE route. */
export function registerBalanceEvents(bb: BbPluginApi): () => void {
  const clients = new Set<{ send: () => void; close: () => void }>();
  let disposed = false;

  function notify(): void { for (const client of clients) client.send(); }
  bb.events.on("thread.idle", ({ thread }) => { if (thread.providerId === "vrata") notify(); });
  bb.events.on("thread.failed", ({ thread }) => { if (thread.providerId === "vrata") notify(); });
  bb.http.route("GET", "/balance-events", (context) => {
    if (disposed) return new Response(null, { status: 503 });
    const signal = context.req.raw.signal;
    const encoder = new TextEncoder();
    let close = () => {};
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const client = {
          send() { if (!closed) controller.enqueue(encoder.encode("data: refresh\n\n")); },
          close() {
            if (closed) return;
            cleanup();
            controller.close();
          },
        };
        cleanup = () => {
          closed = true;
          clearInterval(heartbeat);
          clients.delete(client);
          signal.removeEventListener("abort", close);
        };
        close = client.close;
        const heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
        clients.add(client);
        signal.addEventListener("abort", close, { once: true });
        // Refresh on reconnect as well, covering completions missed while offline.
        if (signal.aborted) close();
        else client.send();
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-store",
        "x-accel-buffering": "no",
      },
    });
  });
  bb.onDispose(() => {
    disposed = true;
    for (const client of clients) client.close();
  });
  return notify;
}
