import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { startRunnerShim } from "../src/runner.js";

describe("runner shim", () => {
  it("forwards POST body to gateway and returns response", async () => {
    const gatewayHits: unknown[] = [];
    const gateway = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        gatewayHits.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, from: "gateway" }));
      })();
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    const gaddr = gateway.address();
    if (!gaddr || typeof gaddr === "string") throw new Error("no gateway port");

    const port = 19000 + Math.floor(Math.random() * 2000);
    const server = await startRunnerShim({
      port,
      gatewayUrl: `http://127.0.0.1:${gaddr.port}/paperclip`,
      log: () => {},
    });

    const res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "r1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, from: "gateway" });
    expect(gatewayHits).toEqual([{ runId: "r1" }]);

    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await new Promise<void>((r, j) => gateway.close((e) => (e ? j(e) : r())));
  });

  it("serves /healthz", async () => {
    const port = 21000 + Math.floor(Math.random() * 2000);
    const server = await startRunnerShim({
      port,
      gatewayUrl: "http://127.0.0.1:9/nope",
      log: () => {},
    });
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });
});
