import { createServer, type Server } from "node:http";

/** Minimal fetch-compatible app surface (avoids Hono env generic friction). */
export type FetchApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

/** Serve a Hono app on Node's http without @hono/node-server. */
export function listen(app: FetchApp, port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const hostHeader = incoming.headers.host ?? `${host}:${port}`;
        const url = new URL(incoming.url ?? "/", `http://${hostHeader}`);

        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
          } else {
            headers.set(key, value);
          }
        }

        const method = incoming.method ?? "GET";
        const init: RequestInit = { method, headers };
        if (rawBody && method !== "GET" && method !== "HEAD") {
          init.body = new Uint8Array(rawBody);
        }
        const request = new Request(url, init);

        const response = await app.fetch(request);
        outgoing.statusCode = response.status;
        response.headers.forEach((value, key) => {
          outgoing.setHeader(key, value);
        });
        const buf = Buffer.from(await response.arrayBuffer());
        outgoing.end(buf);
      } catch (err) {
        outgoing.statusCode = 500;
        outgoing.end(String(err));
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
