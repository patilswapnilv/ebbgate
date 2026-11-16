import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type Db, openDb } from "../src/db/index.js";
import { countPendingDeferred, listPendingDeferred } from "../src/services/queue.js";
import { NODE_TOKEN, presenceBody, runPayload, SECRET, testConfig } from "./helpers/config.js";
import { createFakePaperclip } from "./helpers/fake-paperclip.js";
import { type FakeRunner, startFakeRunner } from "./helpers/fake-runner.js";

describe("dispatcher integration (§10)", () => {
  let db: Db;
  let local: FakeRunner;
  let cloud: FakeRunner;
  let paperclip: ReturnType<typeof createFakePaperclip>;
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
    const config = testConfig({
      localRunner: local.url,
      cloudRunner: cloud.url,
      offlineAfterSeconds,
    });
    return createApp({
      config,
      db,
      paperclip,
      now: () => clock.now,
    });
  }

  async function reportPresence(app: ReturnType<typeof createApp>["app"]): Promise<Response> {
    return app.request("/presence", {
      method: "POST",
      headers: {
        authorization: `Bearer ${NODE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(presenceBody()),
    });
  }

  async function postRun(
    app: ReturnType<typeof createApp>["app"],
    payload: Record<string, unknown>,
  ): Promise<Response> {
    return app.request("/run", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  it("routes private work local when available; defers when offline; wakes once on return; re-decides interrupted runs", async () => {
    const { app, tick } = build(30);

    // 1. Node available → private run goes local.
    const p1 = await reportPresence(app);
    expect(p1.status).toBe(200);

    const localRun = await postRun(
      app,
      runPayload({ runId: "run-local-1", agentId: "agent_inbox", issueId: "issue-a" }),
    );
    expect(localRun.status).toBe(200);
    expect(local.hits).toHaveLength(1);
    expect(cloud.hits).toHaveLength(0);
    expect((local.hits[0] as { runId: string }).runId).toBe("run-local-1");

    // 2. Stop reporting → tick past offlineAfterSeconds → offline.
    clock.now = new Date(clock.now.getTime() + 31_000);
    await tick();

    const statusOffline = await app.request("/status", {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(statusOffline.status).toBe(200);
    const statusBody = (await statusOffline.json()) as {
      nodes: Array<{ node: string; state: string }>;
    };
    expect(statusBody.nodes.find((n) => n.node === "mini")?.state).toBe("offline");

    // 3. Private run while offline → deferred and persisted; 2xx ack.
    const deferredRun = await postRun(
      app,
      runPayload({ runId: "run-defer-1", agentId: "agent_inbox", issueId: "issue-b" }),
    );
    expect(deferredRun.status).toBe(202);
    const deferredJson = (await deferredRun.json()) as { action: string };
    expect(deferredJson.action).toBe("defer");
    expect(countPendingDeferred(db)).toBe(1);
    expect(listPendingDeferred(db)[0]?.run_id).toBe("run-defer-1");
    expect(paperclip.comments.some((c) => c.issueId === "issue-b")).toBe(true);
    expect(
      paperclip.labels.some((l) => l.issueId === "issue-b" && l.label === "waiting-for-local"),
    ).toBe(true);
    expect(local.hits).toHaveLength(1);
    expect(cloud.hits).toHaveLength(0);

    // Second deferred for same issue also persists, but wake dedupes by issue.
    await postRun(
      app,
      runPayload({ runId: "run-defer-2", agentId: "agent_inbox", issueId: "issue-b" }),
    );
    expect(countPendingDeferred(db)).toBe(2);

    // 4. Node returns → wakeAgent called once for the issue.
    clock.now = new Date(clock.now.getTime() + 1_000);
    const p2 = await reportPresence(app);
    expect(p2.status).toBe(200);

    const wakesForB = paperclip.wakes.filter((w) => w.issueId === "issue-b");
    expect(wakesForB).toHaveLength(1);
    expect(countPendingDeferred(db)).toBe(0);

    // 5. Available + in-flight local run → drop node → interrupted → internal re-decides to cloud.
    const inflight = await postRun(
      app,
      runPayload({ runId: "run-inflight", agentId: "agent_ops", issueId: "issue-c" }),
    );
    expect(inflight.status).toBe(200);
    expect(local.hits).toHaveLength(2);

    // Mark the run still "running" as if the forward had not finished yet.
    db.prepare(`UPDATE runs SET status = 'running', finished_at = NULL WHERE run_id = ?`).run(
      "run-inflight",
    );

    clock.now = new Date(clock.now.getTime() + 31_000);
    await tick();

    const interrupted = db
      .prepare(`SELECT status FROM runs WHERE run_id = ?`)
      .get("run-inflight") as { status: string };
    expect(interrupted.status).toBe("interrupted");

    // Internal offline → cloud.
    expect(cloud.hits.length).toBeGreaterThanOrEqual(1);
    const cloudHit = cloud.hits.find(
      (h) =>
        h !== null && typeof h === "object" && (h as { runId?: string }).runId === "run-inflight",
    );
    expect(cloudHit).toBeTruthy();
  });

  it("never forwards a private task to the cloud runner", async () => {
    const { app, tick } = build(10);
    clock.now = new Date("2026-11-16T12:00:00.000Z");
    // No presence → offline.
    await tick();

    const res = await postRun(
      app,
      runPayload({ runId: "run-private-offline", agentId: "agent_inbox", issueId: "issue-priv" }),
    );
    expect(res.status).toBe(202);
    expect(cloud.hits).toHaveLength(0);
    expect(countPendingDeferred(db)).toBe(1);
  });

  it("GET /healthz is open", async () => {
    const { app } = build();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
