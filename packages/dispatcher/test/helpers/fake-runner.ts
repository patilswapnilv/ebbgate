import { createServer, type Server } from "node:http";

export interface FakeRunner {
  url: string;
  hits: unknown[];
  close: () => Promise<void>;
}

/** Minimal HTTP POST sink that records JSON bodies. */
export async function startFakeRunner(label: string): Promise<FakeRunner> {
  const hits: unknown[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        hits.push(raw ? JSON.parse(raw) : null);
      } catch {
        hits.push({ _raw: raw, _label: label });
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, runner: label }));
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("failed to bind fake runner");
  }

  return {
    url: `http://127.0.0.1:${addr.port}/run`,
    hits,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
