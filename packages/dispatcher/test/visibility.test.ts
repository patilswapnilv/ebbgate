import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_PRUNE_INTERVAL_MS, createApp } from "../src/app.js";
import { type Db, openDb } from "../src/db/index.js";
import { listAudit, pruneAudit, queueCounts } from "../src/services/audit.js";
import { persistDeferred } from "../src/services/queue.js";
import { NODE_TOKEN, presenceBody, runPayload, SECRET, testConfig } from "./helpers/config.js";
import { createFakePaperclip } from "./helpers/fake-paperclip.js";
import { type FakeRunner, startFakeRunner } from "./helpers/fake-runner.js";

describe("visibility: decision reasons, audit log, /status, /decisions", () => {
  let db: Db;
  let local: FakeRunner;
  let cloud: FakeRunner;
  let clock: { now: Date };

  beforeEach(async () => {
    db = openDb(":memory:");
    local = await startFakeRunner("local");
    cloud = await startFakeRunner("cloud");
    clock = { now: new Date("2026-11-23T10:00:00.000Z") };
  });

  afterEach(async () => {
    db.close();
    await local.close();
    await cloud.close();
  });

  function build() {
    const config = testConfig({ localRunner: local.url, cloudRunner: cloud.url });
    return createApp({
      config,
      db,
      paperclip: createFakePaperclip(),
      now: () => clock.now,
      demo: false,
    });
  }
  type App = ReturnType<typeof build>["app"];

  const auth = { authorization: `Bearer ${SECRET}` };
  const postRun = (app: App, payload: Record<string, unknown>) =>
    app.request("/run", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const macOnline = (app: App) =>
    app.request("/presence", {
      method: "POST",
      headers: { authorization: `Bearer ${NODE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...presenceBody(), sentAt: clock.now.toISOString() }),
    });
  const getJson = async (app: App, path: string) => {
    const res = await app.request(path, { headers: auth });
    // biome-ignore lint/suspicious/noExplicitAny: assertions walk untyped JSON
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("a private task with the Mac offline is held, audited and explained", async () => {
    const { app } = build();
    const res = await postRun(app, runPayload({ runId: "run-p1", agentId: "agent_inbox" }));
    expect(res.status).toBe(202);

    const [entry] = listAudit(db, { taskId: "run-p1" });
    expect(entry).toMatchObject({
      kind: "route",
      taskId: "run-p1",
      agentId: "agent_inbox",
      decision: "defer",
      target: "queue",
      tier: "private",
      code: "HELD_PRIVATE_MAC_OFFLINE",
      rule: "1",
      presence: "offline",
      decidedAt: "2026-11-23T10:00:00.000Z",
    });
    expect(entry?.text).toContain("held because it's private and your Mac is offline");

    const { status, body } = await getJson(app, "/status");
    expect(status).toBe(200);
    expect(body.presence.overall).toBe("offline");
    expect(body.queue).toMatchObject({ pending: 1, held: 1 });
    expect(body.waiting).toHaveLength(1);
    expect(body.waiting[0]).toMatchObject({
      taskId: "run-p1",
      agentId: "agent_inbox",
      code: "HELD_PRIVATE_MAC_OFFLINE",
    });
    expect(body.topReason).toMatchObject({ code: "HELD_PRIVATE_MAC_OFFLINE", count: 1 });
    // v0.1 fields still present
    expect(body.queueDepth).toBe(1);
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it("the audit log and /status never carry payloads", async () => {
    const { app } = build();
    await macOnline(app);
    const payload = runPayload({ runId: "run-x", agentId: "agent_inbox" });
    (payload.context as Record<string, unknown>).wakeReason = "PAYLOAD_MARKER_DO_NOT_STORE";
    local.hold();
    const pending = postRun(app, payload);
    await local.waitForHits(1);
    const { body } = await getJson(app, "/status");
    expect(body.inFlight).toHaveLength(1);
    expect(body.inFlight[0]).not.toHaveProperty("payload_json");
    expect(JSON.stringify(body)).not.toContain("PAYLOAD_MARKER");
    local.release();
    await pending;
    const rows = db.prepare("SELECT * FROM decision_audit").all();
    expect(JSON.stringify(rows)).not.toContain("PAYLOAD_MARKER");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("explains local and cloud routing with the matched rule", async () => {
    const { app } = build();
    await macOnline(app);
    expect(
      (await postRun(app, runPayload({ runId: "run-l", agentId: "agent_inbox" }))).status,
    ).toBe(200);
    expect(
      (await postRun(app, runPayload({ runId: "run-c", agentId: "agent_research" }))).status,
    ).toBe(200);
    expect(listAudit(db, { taskId: "run-l" })[0]).toMatchObject({
      decision: "local",
      target: "mini",
      code: "RUN_LOCAL",
      presence: "available",
    });
    expect(listAudit(db, { taskId: "run-c" })[0]).toMatchObject({
      decision: "cloud",
      target: "cloud",
      code: "RUN_CLOUD_POLICY",
      rule: "default",
    });
  });

  it("GET /decisions filters, validates and needs the shared secret", async () => {
    const { app } = build();
    await postRun(app, runPayload({ runId: "run-a", agentId: "agent_inbox" }));
    await postRun(app, runPayload({ runId: "run-b", agentId: "agent_ops" }));

    expect((await app.request("/decisions")).status).toBe(401);
    expect(
      (await app.request("/decisions", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    for (const q of [
      "limit=0",
      "limit=501",
      "limit=x",
      "kind=other",
      "taskId=bad%20id",
      "agentId=%3B",
    ]) {
      expect((await getJson(app, `/decisions?${q}`)).status).toBe(400);
    }

    const all = await getJson(app, "/decisions");
    expect(all.body.decisions.map((d: { taskId: string }) => d.taskId)).toEqual(["run-b", "run-a"]);

    const one = await getJson(app, "/decisions?taskId=run-a");
    expect(one.body.decisions).toHaveLength(1);
    expect(one.body.waiting).toMatchObject({ taskId: "run-a", code: "HELD_PRIVATE_MAC_OFFLINE" });

    const ops = await getJson(app, "/decisions?agentId=agent_ops&limit=1");
    expect(ops.body.decisions).toHaveLength(1);
    expect(ops.body.decisions[0]).toMatchObject({ code: "RUN_CLOUD_MAC_OFFLINE" });

    const none = await getJson(app, "/decisions?taskId=nope");
    expect(none.body).toEqual({ decisions: [], waiting: null });
  });

  it("GET /status needs the shared secret", async () => {
    const { app } = build();
    expect((await app.request("/status")).status).toBe(401);
  });

  it("admission answers are audited without a run id", async () => {
    const { app } = build();
    const res = await app.request("/admit", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ target: "remote", agentId: "agent_inbox", environmentId: "env-vps" }),
    });
    expect(await res.json()).toMatchObject({
      admit: false,
      why: { code: "REFUSE_PRIVATE_REMOTE" },
    });
    const { body } = await getJson(app, "/decisions?kind=admission");
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]).toMatchObject({
      kind: "admission",
      taskId: null,
      agentId: "agent_inbox",
      environmentId: "env-vps",
      decision: "refuse",
      target: "remote",
      code: "REFUSE_PRIVATE_REMOTE",
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(0);
  });

  it("the audit table is append-only", async () => {
    const { app } = build();
    await postRun(app, runPayload({ runId: "run-a", agentId: "agent_inbox" }));
    expect(() => db.prepare("UPDATE decision_audit SET reason_code = 'X'").run()).toThrow(
      /append-only/,
    );
  });

  it("waiting tasks deferred before the audit log existed fall back to their stored reason", async () => {
    const { app } = build();
    persistDeferred(db, {
      runId: "legacy",
      agentId: "agent_inbox",
      companyId: "c",
      tier: "private",
      reason: "rule #1 -> defer",
      payload: {},
      createdAt: clock.now.toISOString(),
    });
    expect(queueCounts(db)).toMatchObject({ pending: 1, held: 1 });
    const { body } = await getJson(app, "/status");
    expect(body.waiting[0]).toMatchObject({
      code: "HELD_UNKNOWN",
      text: "held: rule #1 -> defer",
    });
  });

  it("a re-deferred task (<run>:redecide) is explained by its run's decision", async () => {
    const { app } = build();
    await postRun(app, runPayload({ runId: "run-r", agentId: "agent_inbox" }));
    db.prepare("UPDATE deferred SET run_id = 'run-r:redecide'").run();
    const { body } = await getJson(app, "/decisions?taskId=run-r:redecide");
    expect(body.decisions).toHaveLength(1);
    expect(body.waiting).toMatchObject({
      taskId: "run-r:redecide",
      code: "HELD_PRIVATE_MAC_OFFLINE",
    });
  });

  it("retention: prunes by age and by row cap", () => {
    build();
    const insert = db.prepare(
      `INSERT INTO decision_audit (kind, task_id, decision, target, tier, reason_code, reason_text, rule_ref, presence, decided_at)
       VALUES ('route', ?, 'defer', 'queue', 'private', 'HELD_POLICY', 't', '0', 'offline', ?)`,
    );
    insert.run("old", "2026-09-01T00:00:00.000Z");
    for (let i = 0; i < 5; i++) insert.run(`new-${i}`, "2026-11-22T00:00:00.000Z");
    const r = pruneAudit(db, clock.now, { retentionDays: 30, maxRows: 3 });
    expect(r).toEqual({ byAge: 1, byCount: 2 });
    expect(listAudit(db).map((e) => e.taskId)).toEqual(["new-4", "new-3", "new-2"]);
  });

  it("retention runs on the tick, at most once per interval", async () => {
    const { tick } = build();
    const insert = db.prepare(
      `INSERT INTO decision_audit (kind, task_id, decision, target, tier, reason_code, reason_text, rule_ref, presence, decided_at)
       VALUES ('route', ?, 'defer', 'queue', 'private', 'HELD_POLICY', 't', '0', 'offline', ?)`,
    );
    insert.run("old-1", "2026-01-01T00:00:00.000Z");
    await tick();
    expect(listAudit(db)).toHaveLength(0);
    insert.run("old-2", "2026-01-01T00:00:00.000Z");
    await tick(); // within the interval: not pruned again
    expect(listAudit(db)).toHaveLength(1);
    clock.now = new Date(clock.now.getTime() + AUDIT_PRUNE_INTERVAL_MS + 1);
    await tick();
    expect(listAudit(db)).toHaveLength(0);
  });
});
