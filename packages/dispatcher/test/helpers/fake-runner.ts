import { createServer, type Server } from "node:http";

export interface FakeRunner {
  url: string;
  hits: unknown[];
  /** Status the runner answers with (default 200). */
  status: number;
  /** Send headers and part of the body, then never finish the response. */
  stallBody: boolean;
  /** Request headers received, in order. */
  headers: Array<Record<string, string | string[] | undefined>>;
  /** When set, responses wait until `release()` is called. */
  hold(): void;
  release(): void;
  /** Resolves once `n` requests have been received. */
  waitForHits(n: number): Promise<void>;
  close: () => Promise<void>;
}

/** Minimal HTTP POST sink that records JSON bodies, with a controllable response gate. */
export async function startFakeRunner(label: string): Promise<FakeRunner> {
  const hits: unknown[] = [];
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const hitWaiters: Array<{ n: number; resolve: () => void }> = [];

  const runner: Omit<FakeRunner, "url" | "close"> = {
    hits,
    status: 200,
    stallBody: false,
    headers: [],
    hold() {
      gate = new Promise((resolve) => {
        openGate = resolve;
      });
    },
    release() {
      openGate?.();
      gate = null;
      openGate = null;
    },
    waitForHits(n) {
      if (hits.length >= n) return Promise.resolve();
      return new Promise((resolve) => hitWaiters.push({ n, resolve }));
    },
  };

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
      runner.headers.push({ ...req.headers });
      for (const w of hitWaiters.filter((w) => hits.length >= w.n)) w.resolve();

      if (gate) await gate;
      if (runner.stallBody) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"partial":');
        return; // never end
      }
      res.statusCode = runner.status;
      if (runner.status === 204 || runner.status === 304) {
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: runner.status < 400, runner: label }));
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

  return Object.assign(runner, {
    url: `http://127.0.0.1:${addr.port}/run`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        runner.release();
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  });
}
