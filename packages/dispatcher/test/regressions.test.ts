import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type Db, findMigrationsDir, openDb } from "../src/db/index.js";
import { ensureDbDir } from "../src/index.js";
import { createLogger } from "../src/logger.js";
import { isEntrypoint } from "../src/main.js";
import { createHttpPaperclipClient } from "../src/paperclip/client.js";
import { listen } from "../src/serve.js";
import {
  countPendingDeferred,
  drainDeferred,
  persistDeferred,
  WAKE_CLAIM_LEASE_MS,
} from "../src/services/queue.js";
import { NODE_TOKEN, presenceBody, runPayload, SECRET, testConfig } from "./helpers/config.js";
import { createFakePaperclip, type FakePaperclip } from "./helpers/fake-paperclip.js";
import { type FakeRunner, startFakeRunner } from "./helpers/fake-runner.js";

const silent = createLogger("silent");
const quietNotifier = { notify: async () => {} };

describe("dispatcher regressions (PR #1 review)", () => {
  let db: Db;
  let local: FakeRunner;
  let cloud: FakeRunner;
  let paperclip: FakePaperclip;
  let clock: { now: Date };

  beforeEach(async () => {
    db = openDb(":memory:");
    local = await startFakeRunner("local");
    cloud = await startFakeRunner("cloud");
    paperclip = createFakePaperclip();
    clock = { now: new Date("2026-11-16T12:00:00.000Z") };
  });

  afterEach(async () => {
    db.close();
    await local.close();
    await cloud.close();
  });

  function build(offlineAfterSeconds = 30) {
    return createApp({
      config: testConfig({ localRunner: local.url, cloudRunner: cloud.url, offlineAfterSeconds }),
      db,
      paperclip,
      logger: silent,
      notifier: quietNotifier,
      now: () => clock.now,
    });
  }

  type App = ReturnType<typeof build>["app"];

  const presence = (app: App, body: unknown = presenceBody(), token = NODE_TOKEN) =>
    app.request("/presence", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const run = (app: App, payload: Record<string, unknown>) =>
    app.request("/run", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const status = (runId: string) =>
    (db.prepare(`SELECT status FROM runs WHERE run_id = ?`).get(runId) as { status: string })
      ?.status;

  /* -------------------------------------------------------------- */

  it("keeps labels on recovery: an interrupted local-files run waits instead of going to cloud", async () => {
    const { app, tick } = build();
    await presence(app);

    // agent_research is public-tier: only the local-files label keeps it local.
    local.hold();
    const pending = run(
      app,
      runPayload({ runId: "run-lf", agentId: "agent_research", labels: ["local-files"] }),
    );
    await local.waitForHits(1);

    clock.now = new Date(clock.now.getTime() + 31_000);
    await tick();

    expect(status("run-lf")).toBe("interrupted");
    expect(cloud.hits).toHaveLength(0);
    expect(countPendingDeferred(db)).toBe(1);

    local.release();
    await pending;
    expect(status("run-lf")).toBe("interrupted");
  });

  it("marks a replacement run failed when the replacement runner returns an error", async () => {
    const { app, tick } = build();
    await presence(app);
    local.hold();
    const pending = run(app, runPayload({ runId: "run-x", agentId: "agent_ops" }));
    await local.waitForHits(1);

    cloud.status = 500;
    clock.now = new Date(clock.now.getTime() + 31_000);
    await tick();

    expect(status("run-x:cloud")).toBe("failed");
    local.release();
    await pending;
  });

  it("interrupts runs on a busy node that goes offline (local-low work)", async () => {
    const { app, tick } = build();
    await presence(app, { ...presenceBody(), mode: "busy" });
    local.hold();
    const pending = run(app, runPayload({ runId: "run-busy", agentId: "agent_inbox" }));
    await local.waitForHits(1);

    clock.now = new Date(clock.now.getTime() + 31_000);
    await tick();

    expect(status("run-busy")).toBe("interrupted");
    expect(cloud.hits).toHaveLength(0); // private: deferred, never cloud
    expect(countPendingDeferred(db)).toBe(1);
    local.release();
    await pending;
  });

  it.each([204, 205, 304])("relays a bodyless %i from the runner", async (code) => {
    const { app } = build();
    await presence(app);
    local.status = code;
    const res = await run(app, runPayload({ runId: `run-${code}`, agentId: "agent_inbox" }));
    expect(res.status).toBe(code);
    expect(await res.text()).toBe("");
  });

  it("rejects incomplete or invalid presence reports with 400", async () => {
    const { app } = build();
    const missing = { ...presenceBody() } as Record<string, unknown>;
    delete missing.freeRamGb;
    expect((await presence(app, missing)).status).toBe(400);
    expect((await presence(app, { ...presenceBody(), mode: "sleepy" })).status).toBe(400);
    expect((await presence(app, { ...presenceBody(), freeRamGb: "lots" })).status).toBe(400);
    // No state was written by the rejected reports.
    expect(
      (db.prepare(`SELECT state FROM nodes WHERE id = 'mini'`).get() as { state: string }).state,
    ).toBe("offline");
  });

  it("authenticates presence before validating the report", async () => {
    const { app } = build();
    const res = await presence(app, { node: "mini" }, "wrong-token-0123456789");
    expect(res.status).toBe(401);
  });

  it("retries failed wakes on tick without a new presence transition", async () => {
    const { app, tick } = build();
    persistDeferred(db, {
      runId: "run-d1",
      issueId: "issue-d1",
      agentId: "agent_inbox",
      companyId: "c",
      tier: "private",
      reason: "test",
      payload: {},
      createdAt: clock.now.toISOString(),
    });

    paperclip.failNextWakes = 1;
    await presence(app); // offline -> available: drain, wake fails
    expect(paperclip.wakes).toHaveLength(0);
    expect(countPendingDeferred(db)).toBe(1);

    clock.now = new Date(clock.now.getTime() + 5_000);
    await presence(app); // still available: no transition
    await tick(); // retry path
    expect(paperclip.wakes).toHaveLength(1);
    expect(paperclip.wakes[0]?.idempotencyKey).toBe("ebbgate-defer-run-d1");
    expect(countPendingDeferred(db)).toBe(0);
  });

  it("never wakes the same deferred row twice when drains overlap", async () => {
    for (const id of ["a", "b", "c"]) {
      persistDeferred(db, {
        runId: `run-${id}`,
        issueId: `issue-${id}`,
        agentId: "agent_inbox",
        companyId: "c",
        tier: "private",
        reason: "test",
        payload: {},
        createdAt: clock.now.toISOString(),
      });
    }
    let open!: () => void;
    paperclip.wakeGate = new Promise((resolve) => {
      open = resolve;
    });
    const args = {
      db,
      paperclip,
      notifier: quietNotifier,
      logger: silent,
      now: clock.now,
      deferredMaxAgeHours: 72,
      drainConcurrency: 2,
    };
    const first = drainDeferred(args);
    const second = drainDeferred(args);
    open();
    await Promise.all([first, second]);
    expect(paperclip.wakes.map((w) => w.issueId).sort()).toEqual(["issue-a", "issue-b", "issue-c"]);
  });

  it("serializes drains started from the presence service (respects drainConcurrency)", async () => {
    const { app, presence: svc } = build();
    for (const id of ["a", "b", "c", "d"]) {
      persistDeferred(db, {
        runId: `run-s-${id}`,
        issueId: `issue-s-${id}`,
        agentId: "agent_inbox",
        companyId: "c",
        tier: "private",
        reason: "test",
        payload: {},
        createdAt: clock.now.toISOString(),
      });
    }
    let open!: () => void;
    paperclip.wakeGate = new Promise((resolve) => {
      open = resolve;
    });
    const a = presence(app); // transition drain
    const b = svc.drain();
    const c = svc.drain();
    await new Promise((r) => setTimeout(r, 20)); // let any parallel drain start its wakes
    open();
    await Promise.all([a, b, c]);
    expect(paperclip.wakes).toHaveLength(4);
    expect(paperclip.maxInFlightWakes).toBeLessThanOrEqual(2); // drainConcurrency
  });

  it("releases wake claims abandoned by a crash after the lease expires", async () => {
    persistDeferred(db, {
      runId: "run-crash",
      issueId: "issue-crash",
      agentId: "agent_inbox",
      companyId: "c",
      tier: "private",
      reason: "test",
      payload: {},
      createdAt: clock.now.toISOString(),
    });
    // Simulate a process that claimed the row and died before finishing.
    db.prepare(`UPDATE deferred SET status = 'waking', claimed_at = ?`).run(
      clock.now.toISOString(),
    );
    const args = {
      db,
      paperclip,
      notifier: quietNotifier,
      logger: silent,
      deferredMaxAgeHours: 72,
      drainConcurrency: 2,
    };

    await drainDeferred({ ...args, now: new Date(clock.now.getTime() + 1_000) });
    expect(paperclip.wakes).toHaveLength(0); // claim still held

    await drainDeferred({ ...args, now: new Date(clock.now.getTime() + WAKE_CLAIM_LEASE_MS + 1) });
    expect(paperclip.wakes).toHaveLength(1);
    expect(paperclip.wakes[0]?.idempotencyKey).toBe("ebbgate-defer-run-crash");
  });
});

describe("Paperclip client addLabel", () => {
  function fakeApi(issue: { companyId?: string; labelIds: string[] }) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const state = { ...issue, labelIds: [...issue.labelIds] };
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/issues/issue-1") {
        return Response.json({ id: "issue-1", ...state });
      }
      if (method === "GET" && path === "/api/companies/company-1/labels") {
        return Response.json([{ id: "lbl-wait", name: "waiting-for-local" }]);
      }
      if (method === "PATCH" && path === "/api/issues/issue-1") {
        state.labelIds = body.labelIds;
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = createHttpPaperclipClient({
      apiUrl: "http://paperclip.test",
      apiKey: "k",
      fetch: fetchFn,
    });
    return { client, calls, state };
  }

  it("uses the issue's companyId and keeps existing labels", async () => {
    const { client, calls, state } = fakeApi({ companyId: "company-1", labelIds: ["lbl-other"] });
    await client.addLabel("issue-1", "waiting-for-local");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ labelIds: ["lbl-other", "lbl-wait"] });
    expect(state.labelIds).toEqual(["lbl-other", "lbl-wait"]);
  });

  it("does not write when the label is already present", async () => {
    const { client, calls } = fakeApi({ companyId: "company-1", labelIds: ["lbl-wait"] });
    await client.addLabel("issue-1", "waiting-for-local");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("fails clearly when no company id is available", async () => {
    const { client } = fakeApi({ labelIds: [] });
    await expect(client.addLabel("issue-1", "waiting-for-local")).rejects.toThrow(/companyId/);
  });
});

describe("server and startup", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  const echo = { fetch: async (req: Request) => new Response(await req.text()) };

  it("returns 413 for bodies over the limit, counted as they stream", async () => {
    server = await listen(echo, { port: 0, maxBodyBytes: 2048 });
    const port = (server.address() as { port: number }).port;
    const big = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: "x".repeat(4096),
    });
    expect(big.status).toBe(413);
    const ok = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "hello" });
    expect(await ok.text()).toBe("hello");
  });

  it("binds to the configured host", async () => {
    server = await listen(echo, { port: 0, host: "0.0.0.0" });
    expect((server.address() as { address: string }).address).toBe("0.0.0.0");
  });

  it("defaults the bind address to loopback", async () => {
    server = await listen(echo, { port: 0 });
    expect((server.address() as { address: string }).address).toBe("127.0.0.1");
  });

  it("creates the database's parent directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ebbgate-"));
    try {
      const dbPath = join(root, "nested", "deeper", "ebbgate.db");
      ensureDbDir(dbPath);
      const db = openDb(dbPath);
      db.close();
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies every SQL migration", () => {
    const db = openDb(":memory:");
    const ids = (db.prepare(`SELECT id FROM schema_migrations`).all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).toEqual(expect.arrayContaining(["001_init.sql", "002_deferred_claims.sql"]));
    db.close();
  });

  it("fails loudly when migrations are missing", () => {
    expect(() => findMigrationsDir(["/nonexistent/migrations"])).toThrow(/migrations not found/);
  });

  it("only treats the executed file as the entrypoint", () => {
    const here = new URL(import.meta.url);
    expect(isEntrypoint(here.href, here.pathname)).toBe(true);
    expect(isEntrypoint(here.href, "/usr/lib/node_modules/some-other-tool/index.js")).toBe(false);
    expect(isEntrypoint(here.href, undefined)).toBe(false);
  });
});

describe("production logger", () => {
  it("createLogger redacts secrets in its real output", async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const logger = createLogger("info", sink);
    logger.info({ authorization: "Bearer s3cr3t-value-abcdef", apiKey: "k-123456" }, "x");
    await new Promise((r) => setTimeout(r, 10));
    const out = chunks.join("");
    expect(out).not.toContain("s3cr3t-value-abcdef");
    expect(out).not.toContain("k-123456");
    expect(out).toContain("[Redacted]");
  });
});
