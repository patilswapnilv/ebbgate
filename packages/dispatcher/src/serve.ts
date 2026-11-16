import { createServer, type Server } from "node:http";

/** Minimal fetch-compatible app surface (avoids Hono env generic friction). */
export type FetchApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export interface ListenOptions {
  port: number;
  /** Bind address. Defaults to loopback for deployments behind a local reverse proxy. */
  host?: string;
  /** Largest request body read into memory, in bytes. Larger bodies get HTTP 413. */
  maxBodyBytes?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

/** Serve a Hono app on Node's http without @hono/node-server. */
export function listen(app: FetchApp, opts: ListenOptions): Promise<Server> {
  const host = opts.host ?? "127.0.0.1";
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        // Count bytes as they arrive; never trust Content-Length alone.
        const chunks: Buffer[] = [];
        let received = 0;
        try {
          for await (const chunk of incoming) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += buf.length;
            if (received > maxBodyBytes) throw new BodyTooLargeError();
            chunks.push(buf);
          }
        } catch (err) {
          if (!(err instanceof BodyTooLargeError)) throw err;
          outgoing.statusCode = 413;
          outgoing.setHeader("content-type", "application/json");
          outgoing.setHeader("connection", "close");
          outgoing.end(JSON.stringify({ error: "request body too large" }));
          incoming.destroy();
          return;
        }

        const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const hostHeader = incoming.headers.host ?? `${host}:${opts.port}`;
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

        const response = await app.fetch(new Request(url, init));
        outgoing.statusCode = response.status;
        response.headers.forEach((value, key) => {
          outgoing.setHeader(key, value);
        });
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!outgoing.headersSent) {
          outgoing.statusCode = 500;
          outgoing.setHeader("content-type", "application/json");
        }
        outgoing.end(JSON.stringify({ error: "internal error" }));
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve(server));
  });
}
