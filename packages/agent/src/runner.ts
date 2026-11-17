import { createServer, type Server } from "node:http";

export interface RunnerShimOptions {
  port: number;
  gatewayUrl: string;
  host?: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Tiny local runner: listen on port (default 8787) and forward POSTs to the
 * local OpenClaw gateway URL so the dispatcher has one stable node endpoint.
 */
export function startRunnerShim(opts: RunnerShimOptions): Promise<Server> {
  const fetchFn = opts.fetch ?? fetch;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.log ?? ((m) => console.error(m));

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        if (incoming.method === "GET" && incoming.url === "/healthz") {
          outgoing.statusCode = 200;
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(JSON.stringify({ ok: true }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of incoming) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = chunks.length ? Buffer.concat(chunks) : undefined;

        const headers: Record<string, string> = {
          "content-type": incoming.headers["content-type"] ?? "application/json",
        };
        if (incoming.headers.authorization) {
          headers.authorization = String(incoming.headers.authorization);
        }

        const init: RequestInit = {
          method: incoming.method ?? "POST",
          headers,
        };
        if (body && incoming.method !== "GET" && incoming.method !== "HEAD") {
          init.body = body;
        }

        const res = await fetchFn(opts.gatewayUrl, init);
        outgoing.statusCode = res.status;
        const ct = res.headers.get("content-type");
        if (ct) outgoing.setHeader("content-type", ct);
        const buf = Buffer.from(await res.arrayBuffer());
        outgoing.end(buf);
      } catch (err) {
        log(`ebbgate runner: forward failed: ${String(err)}`);
        outgoing.statusCode = 502;
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(JSON.stringify({ error: "gateway unreachable" }));
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve(server));
  });
}
