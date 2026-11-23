import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EbbgateConfig } from "@ebbgate/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { configureDb, type Db, findMigrationsDir, migrate, openDb } from "../src/db/index.js";
import { runMain } from "../src/index.js";
import { createLogger } from "../src/logger.js";
import type { PaperclipClient } from "../src/paperclip/types.js";
import type { NotifyEvent } from "../src/services/notifier.js";
import {
  backoffMs,
  countDeferredByStatus,
  DEFAULT_QUEUE_POLICY,
  type DeferredRow,
  drainDeferred,
  getDeferredByRunId,
  listDeadLetters,
  persistDeferred,
  reclaimAbandonedClaims,
  releaseStaleClaims,
} from "../src/services/queue.js";
import { finishRun, insertRunning } from "../src/services/runs.js";
import { NODE_TOKEN, presenceBody, runPayload, SECRET, testConfig } from "./helpers/config.js";
import { createFakePaperclip, type FakePaperclip } from "./helpers/fake-paperclip.js";
import { type FakeRunner, startFakeRunner } from "./helpers/fake-runner.js";

const silent = createLogger("silent");
const T0 = new Date("2026-11-23T10:00:00.000Z");
const never = new Promise<void>(() => {});

function recordingNotifier() {
  const events: Array<{ event: NotifyEvent; message: string }> = [];
  return {
    events,
    notify: async (event: NotifyEvent, _n: string | null, message: string) => {
      events.push({ event, message });
    },
  };
}

function defer(db: Db, runId: string, extra: Partial<Parameters<typeof persistDeferred>[1]> = {}) {
  return persistDeferred(db, {
    runId,
    issueId: `issue-${runId}`,
    agentId: "agent_inbox",
    companyId: "c",
    tier: "private",
    reason: "test",
    payload: {},
    createdAt: T0.toISOString(),
    ...extra,
  });
}

const rowOf = (db: Db, runId: string) => getDeferredByRunId(db, runId) as DeferredRow;

let dir: string;
let local: FakeRunner;
let cloud: FakeRunner;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ebbgate-durable-"));
  local = await startFakeRunner("local");
  cloud = await startFakeRunner("cloud");
});

afterEach(async () => {
  await local.close();
  await cloud.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<EbbgateConfig> = {}): EbbgateConfig {
  const base = testConfig({
    localRunner: local.url,
    cloudRunner: cloud.url,
    offlineAfterSeconds: 30,
  });
  return { ...base, ...overrides };
}

function build(db: Db, paperclip: PaperclipClient, clock: { now: Date }, cfg = config()) {
  return createApp({
    config: cfg,
    db,
    paperclip,
    logger: silent,
    notifier: { notify: async () => {} },
    now: () => clock.now,
  });
}

type App = ReturnType<typeof build>["app"];
const postPresence = (app: App) =>
  app.request("/presence", {
    method: "POST",
    headers: { authorization: `Bearer ${NODE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(presenceBody()),
  });
const postRun = (app: App, payload: Record<string, unknown>) =>
  app.request("/run", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

/* ------------------------------------------------------------------ */

describe("SQLite durability settings and migration 005", () => {
  it("opens file databases in WAL mode with synchronous=FULL and a busy timeout", () => {
    const db = openDb(join(dir, "e.db"));
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("synchronous", { simple: true })).toBe(2);
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("upgrades a v004 database in place, keeping every row and backfilling keys and reasons", () => {
    const file = join(dir, "old.db");
    const oldDir = join(dir, "migrations-004");
    mkdirSync(oldDir);
    const all = findMigrationsDir();
    for (const f of readdirSync(all).filter((f) => f < "005")) {
      copyFileSync(join(all, f), join(oldDir, f));
    }
    const old = new Database(file);
    configureDb(old);
    migrate(old, oldDir);
    const ins = old.prepare(
      `INSERT INTO deferred (run_id, agent_id, company_id, tier, reason, payload_json, created_at, status, wake_idempotency_key, claimed_at)
       VALUES (?, 'a', 'c', 'private', 'r', '{}', ?, ?, ?, ?)`,
    );
    ins.run("r-pending", T0.toISOString(), "pending", null, null);
    ins.run("r-waking", T0.toISOString(), "waking", "ebbgate-defer-r-waking", T0.toISOString());
    ins.run("r-done", T0.toISOString(), "done", "ebbgate-defer-r-done", null);
    ins.run("r-expired", T0.toISOString(), "expired", "ebbgate-defer-r-expired", null);
    old.close();

    const db = openDb(file);
    try {
      const rows = db.prepare(`SELECT * FROM deferred ORDER BY id`).all() as DeferredRow[];
      expect(rows.map((r) => [r.run_id, r.status, r.attempts])).toEqual([
        ["r-pending", "pending", 0],
        ["r-waking", "waking", 0],
        ["r-done", "done", 0],
        ["r-expired", "expired", 0],
      ]);
      expect(rows[0]?.wake_idempotency_key).toBe("ebbgate-defer-r-pending");
      expect(rows[2]?.terminal_reason).toMatch(/woken/);
      expect(rows[3]?.terminal_reason).toMatch(/expired/);
      // The new terminal state is accepted; unknown states are still rejected.
      expect(() =>
        db.prepare(`UPDATE deferred SET status = 'dead' WHERE id = 1`).run(),
      ).not.toThrow();
      expect(() => db.prepare(`UPDATE deferred SET status = 'lost' WHERE id = 1`).run()).toThrow();
      // Idempotency keys are unique.
      expect(() =>
        db
          .prepare(`UPDATE deferred SET wake_idempotency_key = 'ebbgate-defer-r-done' WHERE id = 1`)
          .run(),
      ).toThrow(/UNIQUE/);
      // A pre-005 claim (claimed_at only, no lease) is still reclaimed by age.
      expect(
        releaseStaleClaims(db, new Date(T0.getTime() + DEFAULT_QUEUE_POLICY.leaseMs + 1)),
      ).toBe(1);
    } finally {
      db.close();
    }
    // Re-opening applies nothing twice.
    const again = openDb(file);
    expect(
      again.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE id LIKE '005%'`).get(),
    ).toEqual({ n: 1 });
    again.close();
  });
});

describe("crash recovery: a process killed mid-dispatch", () => {
  it("reclaims a claim abandoned mid-wake on restart and wakes exactly once, with the same key", async () => {
    const file = join(dir, "e.db");
    const clock = { now: T0 };

    // Process A: claims the row, then "dies" while the wake is in flight.
    const dbA = openDb(file);
    defer(dbA, "run-kill");
    const pcA = createFakePaperclip();
    pcA.wakeGate = never; // the wake never returns: the process is gone
    const a = build(dbA, pcA, clock);
    void postPresence(a.app); // offline -> available triggers a drain that hangs
    await new Promise((r) => setTimeout(r, 20));
    expect(rowOf(dbA, "run-kill")).toMatchObject({
      status: "waking",
      attempts: 1,
      lease_owner: a.presence.owner,
    });

    // Process B: same file, new connection, startup reconcile, node comes back.
    const dbB = openDb(file);
    const pcB = createFakePaperclip();
    const b = build(dbB, pcB, clock);
    await b.presence.reconcileAfterRestart();
    expect(rowOf(dbB, "run-kill")).toMatchObject({ status: "pending", lease_owner: null });
    // The stored node state is already `available` (A wrote it), so the heartbeat
    // is not a transition: the ticker is what drains after a restart.
    await postPresence(b.app);
    await b.tick();

    expect(pcB.wakes).toHaveLength(1);
    expect(pcB.wakes[0]?.idempotencyKey).toBe("ebbgate-defer-run-kill");
    expect(rowOf(dbB, "run-kill")).toMatchObject({
      status: "done",
      terminal_reason: "woken",
      attempts: 2,
    });

    // A second restart finds nothing to redo.
    const dbC = openDb(file);
    const pcC = createFakePaperclip();
    const c = build(dbC, pcC, clock);
    await c.presence.reconcileAfterRestart();
    await postPresence(c.app);
    await c.tick();
    expect(pcC.wakes).toHaveLength(0);
    dbB.close();
    dbC.close();
    // dbA is deliberately leaked with its hung drain, like a killed process.
  });

  it("re-sends with the same idempotency key when the process died after the wake but before the commit", async () => {
    const file = join(dir, "e.db");
    const delivered: Array<string | undefined> = [];
    const dbA = openDb(file);
    defer(dbA, "run-commit");
    const deliveredThenDie: PaperclipClient = {
      ...createFakePaperclip(),
      async wakeAgent(args) {
        delivered.push(args.idempotencyKey);
        await never; // Paperclip got it; we die before recording success
      },
    };
    void drainDeferred({
      db: dbA,
      paperclip: deliveredThenDie,
      notifier: { notify: async () => {} },
      logger: silent,
      clock: () => T0,
      deferredMaxAgeHours: 72,
      drainConcurrency: 2,
      owner: "proc-a",
    });
    await new Promise((r) => setTimeout(r, 10));

    const dbB = openDb(file);
    expect(reclaimAbandonedClaims(dbB, "proc-b", T0)).toEqual({ released: 1, dead: 0 });
    const pcB = createFakePaperclip();
    await drainDeferred({
      db: dbB,
      paperclip: pcB,
      notifier: { notify: async () => {} },
      logger: silent,
      clock: () => T0,
      deferredMaxAgeHours: 72,
      drainConcurrency: 2,
      owner: "proc-b",
    });
    // At-least-once delivery, deduplicated downstream by an identical key.
    expect([...delivered, ...pcB.wakes.map((w) => w.idempotencyKey)]).toEqual([
      "ebbgate-defer-run-commit",
      "ebbgate-defer-run-commit",
    ]);
    expect(rowOf(dbB, "run-commit").status).toBe("done");
    dbB.close();
  });

  it("survives close and reopen between every step without losing or duplicating a task", async () => {
    const file = join(dir, "e.db");
    const pc = createFakePaperclip();
    pc.failNextWakes = 1;
    const step = async (fn: (db: Db) => Promise<void> | void) => {
      const db = openDb(file);
      try {
        await fn(db);
      } finally {
        db.close();
      }
    };
    const drain = (db: Db, at: Date) =>
      drainDeferred({
        db,
        paperclip: pc,
        notifier: { notify: async () => {} },
        logger: silent,
        clock: () => at,
        deferredMaxAgeHours: 72,
        drainConcurrency: 2,
      });
    await step((db) => {
      defer(db, "run-reopen");
    });
    await step((db) => {
      expect(defer(db, "run-reopen").created).toBe(false); // re-submit after restart: deduped
    });
    await step(async (db) => {
      expect(await drain(db, T0)).toMatchObject({ failed: 1, woken: 0 });
    });
    await step(async (db) => {
      expect(rowOf(db, "run-reopen")).toMatchObject({ status: "pending", attempts: 1 });
      expect(rowOf(db, "run-reopen").last_error).toMatch(/paperclip unavailable/);
      expect(await drain(db, new Date(T0.getTime() + 60_000))).toMatchObject({ woken: 1 });
    });
    await step(async (db) => {
      expect(await drain(db, new Date(T0.getTime() + 120_000))).toMatchObject({ woken: 0 });
      expect(countDeferredByStatus(db)).toMatchObject({ pending: 0, waking: 0, done: 1 });
    });
    expect(pc.wakes).toHaveLength(1);
  });
});

describe("concurrent and repeated drains", () => {
  it("double drain on the same connection wakes every row once", async () => {
    const db = openDb(join(dir, "e.db"));
    for (const id of ["a", "b", "c", "d", "e"]) defer(db, `run-${id}`);
    const pc = createFakePaperclip();
    let open!: () => void;
    pc.wakeGate = new Promise((r) => {
      open = r;
    });
    const args = {
      db,
      paperclip: pc,
      notifier: { notify: async () => {} },
      logger: silent,
      clock: () => T0,
      deferredMaxAgeHours: 72,
      drainConcurrency: 2,
    };
    const first = drainDeferred(args);
    const second = drainDeferred(args);
    open();
    await Promise.all([first, second]);
    await drainDeferred(args);
    expect(pc.wakes.map((w) => w.issueId).sort()).toEqual([
      "issue-run-a",
      "issue-run-b",
      "issue-run-c",
      "issue-run-d",
      "issue-run-e",
    ]);
    db.close();
  });

  it("two drainers on separate connections to one file never wake a row twice", async () => {
    const file = join(dir, "e.db");
    const dbA = openDb(file);
    const dbB = openDb(file);
    for (let i = 0; i < 12; i++) defer(dbA, `run-${i}`);
    const pc = createFakePaperclip();
    let open!: () => void;
    pc.wakeGate = new Promise((r) => {
      open = r;
    });
    const drain = (db: Db, owner: string) =>
      drainDeferred({
        db,
        paperclip: pc,
        notifier: { notify: async () => {} },
        logger: silent,
        clock: () => T0,
        deferredMaxAgeHours: 72,
        drainConcurrency: 3,
        owner,
      });
    const a = drain(dbA, "proc-a");
    const b = drain(dbB, "proc-b");
    setTimeout(open, 10);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.woken + rb.woken).toBe(12);
    const keys = pc.wakes.map((w) => w.idempotencyKey);
    expect(new Set(keys).size).toBe(12);
    expect(keys).toHaveLength(12);
    expect(countDeferredByStatus(dbB)).toMatchObject({ done: 12, pending: 0, waking: 0 });
    dbA.close();
    dbB.close();
  });
});

describe("bounded retries, backoff and the dead-letter state", () => {
  it("computes exponential backoff with a cap", () => {
    const p = { ...DEFAULT_QUEUE_POLICY, retryBaseMs: 1000, retryMaxMs: 10_000 };
    expect([1, 2, 3, 4, 5, 50].map((n) => backoffMs(n, p))).toEqual([
      1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });

  it("backs off between failed wakes and dead-letters with the last error after maxAttempts", async () => {
    const db = openDb(":memory:");
    defer(db, "run-poison");
    const pc = createFakePaperclip();
    pc.failNextWakes = 1_000;
    const notifier = recordingNotifier();
    const policy = { maxAttempts: 3, retryBaseMs: 1000, retryMaxMs: 60_000 };
    const at = (ms: number) =>
      drainDeferred({
        db,
        paperclip: pc,
        notifier,
        logger: silent,
        clock: () => new Date(T0.getTime() + ms),
        deferredMaxAgeHours: 72,
        drainConcurrency: 1,
        policy,
      });
    const attempts = () => rowOf(db, "run-poison").attempts;

    await at(0);
    expect(attempts()).toBe(1);
    expect(rowOf(db, "run-poison").next_attempt_at).toBe(
      new Date(T0.getTime() + 1000).toISOString(),
    );
    await at(500); // still backing off
    expect(attempts()).toBe(1);
    await at(1000);
    expect(attempts()).toBe(2);
    await at(2500); // next is at 1000 + 2000
    expect(attempts()).toBe(2);
    expect(await at(3000)).toMatchObject({ failed: 1, dead: 1 });

    const row = rowOf(db, "run-poison");
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(3);
    expect(row.terminal_reason).toMatch(
      /wake failed 3 time\(s\); last error: .*paperclip unavailable/,
    );
    expect(row.finished_at).toBe(new Date(T0.getTime() + 3000).toISOString());
    expect(listDeadLetters(db).map((r) => r.run_id)).toEqual(["run-poison"]);
    expect(notifier.events.some((e) => e.event === "deferred_dead")).toBe(true);

    await at(3_600_000);
    expect(attempts()).toBe(3); // dead is terminal
    db.close();
  });

  it("dead-letters a claim whose lease keeps expiring (a wake that hangs every time)", () => {
    const db = openDb(":memory:");
    defer(db, "run-hang");
    db.prepare(
      `UPDATE deferred SET status = 'waking', attempts = 3, lease_owner = 'gone', claimed_at = ?, lease_expires_at = ?`,
    ).run(T0.toISOString(), T0.toISOString());
    expect(releaseStaleClaims(db, new Date(T0.getTime() + 1), 1000, 3)).toBe(0);
    expect(rowOf(db, "run-hang")).toMatchObject({ status: "dead" });
    expect(rowOf(db, "run-hang").terminal_reason).toMatch(/lease expired after 3 attempt/);
    db.close();
  });

  it("a covered row for the same issue stays retryable when the primary is dead-lettered", async () => {
    const db = openDb(":memory:");
    defer(db, "run-p", { issueId: "issue-shared" });
    defer(db, "run-q", {
      issueId: "issue-shared",
      createdAt: new Date(T0.getTime() + 1).toISOString(),
    });
    const pc = createFakePaperclip();
    pc.failNextWakes = 1;
    const args = {
      db,
      paperclip: pc,
      notifier: { notify: async () => {} },
      logger: silent,
      clock: () => new Date(T0.getTime() + 10),
      deferredMaxAgeHours: 72,
      drainConcurrency: 1,
      policy: { maxAttempts: 1 },
    };
    await drainDeferred(args);
    expect(rowOf(db, "run-p").status).toBe("dead");
    expect(rowOf(db, "run-q").status).toBe("pending");
    await drainDeferred(args);
    expect(rowOf(db, "run-q")).toMatchObject({ status: "done", terminal_reason: "woken" });
    db.close();
  });
});

describe("expiry (TTL) and the private guarantee", () => {
  it("expires a private task at its per-agent TTL with a reason, and never routes it anywhere", async () => {
    const db = openDb(":memory:");
    const clock = { now: T0 };
    const base = config();
    const cfg = config({
      agents: { ...base.agents, agent_inbox: { tier: "private", deferTtlHours: 1 } },
    });
    const pc = createFakePaperclip();
    const { app, tick } = build(db, pc, clock, cfg);

    const res = await postRun(app, runPayload({ runId: "run-ttl", agentId: "agent_inbox" }));
    expect(res.status).toBe(202); // node offline: deferred
    expect(rowOf(db, "run-ttl").expires_at).toBe(new Date(T0.getTime() + 3600_000).toISOString());

    clock.now = new Date(T0.getTime() + 2 * 3600_000);
    await postPresence(app); // node back: drain finds it expired
    await tick();

    const row = rowOf(db, "run-ttl");
    expect(row.status).toBe("expired");
    expect(row.terminal_reason).toMatch(/TTL.*not re-routed/);
    expect(pc.wakes).toHaveLength(0);
    expect(cloud.hits).toHaveLength(0);
    expect(local.hits).toHaveLength(0);
    db.close();
  });

  it("falls back to deferredMaxAgeHours when no TTL is set", async () => {
    const db = openDb(":memory:");
    defer(db, "run-default");
    expect(rowOf(db, "run-default").expires_at).toBeNull();
    const pc = createFakePaperclip();
    const r = await drainDeferred({
      db,
      paperclip: pc,
      notifier: { notify: async () => {} },
      logger: silent,
      clock: () => new Date(T0.getTime() + 73 * 3600_000),
      deferredMaxAgeHours: 72,
      drainConcurrency: 1,
    });
    expect(r.expired).toBe(1);
    expect(rowOf(db, "run-default").terminal_reason).toMatch(/72h queue limit/);
    db.close();
  });

  it("a private task that exhausts its retries is dead-lettered, never sent to the cloud runner", async () => {
    const db = openDb(":memory:");
    const clock = { now: T0 };
    const cfg = config({ queue: { ...config().queue, maxAttempts: 2, retryBaseSeconds: 1 } });
    const pc = createFakePaperclip();
    pc.failNextWakes = 100;
    const { app, tick } = build(db, pc, clock, cfg);
    expect(
      (await postRun(app, runPayload({ runId: "run-priv", agentId: "agent_inbox" }))).status,
    ).toBe(202);
    await postPresence(app);
    for (let i = 1; i <= 5; i++) {
      clock.now = new Date(T0.getTime() + i * 10_000);
      await postPresence(app);
      await tick();
    }
    expect(rowOf(db, "run-priv")).toMatchObject({ status: "dead", attempts: 2 });
    expect(cloud.hits).toHaveLength(0);
    expect(local.hits).toHaveLength(0);
    db.close();
  });
});

describe("idempotent ingress", () => {
  let db: Db;
  let pc: FakePaperclip;
  const clock = { now: T0 };
  beforeEach(() => {
    db = openDb(":memory:");
    pc = createFakePaperclip();
    clock.now = T0;
  });
  afterEach(() => db.close());

  it("deduplicates a re-submitted deferred run: one row, one comment, 202 both times", async () => {
    const { app } = build(db, pc, clock);
    const payload = runPayload({ runId: "run-dup", agentId: "agent_inbox" });
    const first = await postRun(app, payload);
    const second = await postRun(app, payload);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ action: "defer", duplicate: true });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM deferred`).get()).toEqual({ n: 1 });
    expect(pc.comments).toHaveLength(1);
  });

  it("answers 409 for a re-submit of a deferred run that already finished", async () => {
    const { app } = build(db, pc, clock);
    const payload = runPayload({ runId: "run-dup2", agentId: "agent_inbox" });
    await postRun(app, payload);
    await postPresence(app); // drains: done
    expect(rowOf(db, "run-dup2").status).toBe("done");
    const again = await postRun(app, payload);
    expect(again.status).toBe(409);
    expect(local.hits).toHaveLength(0);
  });

  it("never runs a completed local run twice", async () => {
    const { app } = build(db, pc, clock);
    await postPresence(app);
    const payload = runPayload({ runId: "run-once", agentId: "agent_inbox" });
    expect((await postRun(app, payload)).status).toBe(200);
    expect((await postRun(app, payload)).status).toBe(409);
    expect(local.hits).toHaveLength(1);
  });

  it("retries a run that previously failed (for example after a dispatcher restart)", async () => {
    const { app } = build(db, pc, clock);
    await postPresence(app);
    insertRunning(db, {
      runId: "run-retry",
      agentId: "agent_inbox",
      companyId: "c",
      target: "local",
      nodeId: "mini",
      startedAt: T0.toISOString(),
      payload: {},
    });
    finishRun(db, "run-retry", "failed", T0.toISOString());
    const res = await postRun(app, runPayload({ runId: "run-retry", agentId: "agent_inbox" }));
    expect(res.status).toBe(200);
    expect(local.hits).toHaveLength(1);
    expect(
      (db.prepare(`SELECT status FROM runs WHERE run_id = 'run-retry'`).get() as { status: string })
        .status,
    ).toBe("completed");
  });
});

describe("graceful shutdown", () => {
  it("waits for an in-flight wake within the grace period, then has nothing to release", async () => {
    const db = openDb(":memory:");
    defer(db, "run-grace");
    const pc = createFakePaperclip();
    let open!: () => void;
    pc.wakeGate = new Promise((r) => {
      open = r;
    });
    const clock = { now: T0 };
    const { app, presence } = build(db, pc, clock);
    const pending = postPresence(app);
    await new Promise((r) => setTimeout(r, 10));
    setTimeout(open, 10);
    expect(await presence.shutdown({ graceMs: 2000 })).toEqual({
      releasedClaims: 0,
      timedOut: false,
    });
    await pending;
    expect(rowOf(db, "run-grace").status).toBe("done");
    db.close();
  });

  it("releases claims still held after the grace period, and stops draining", async () => {
    const db = openDb(":memory:");
    defer(db, "run-stuck");
    defer(db, "run-later");
    const pc = createFakePaperclip();
    pc.wakeGate = never;
    const clock = { now: T0 };
    const cfg = config({ presence: { ...config().presence, drainConcurrency: 1 } });
    const { app, presence, tick } = build(db, pc, clock, cfg);
    void postPresence(app);
    await new Promise((r) => setTimeout(r, 10));
    expect(rowOf(db, "run-stuck").status).toBe("waking");

    expect(await presence.shutdown({ graceMs: 20 })).toEqual({ releasedClaims: 1, timedOut: true });
    expect(rowOf(db, "run-stuck")).toMatchObject({ status: "pending", lease_owner: null });
    expect(rowOf(db, "run-later").status).toBe("pending");
    await presence.drain();
    await tick();
    expect(countDeferredByStatus(db)).toMatchObject({ pending: 2, waking: 0 });
    db.close();
  });

  it("the started dispatcher shuts down cleanly and its database reopens intact", async () => {
    const cfgFile = join(dir, "ebbgate.yaml");
    const dbFile = join(dir, "data", "e.db");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    writeFileSync(
      cfgFile,
      [
        `server: { port: ${port}, publicUrl: "http://127.0.0.1:${port}" }`,
        `nodes:\n  mini: { runner: "${local.url}", token: "mini-token-0123456789abcdef" }`,
        `cloud: { runner: "${cloud.url}" }`,
        `paperclip: { apiUrl: "http://127.0.0.1:9", apiKey: k, sharedSecret: "${SECRET}" }`,
        "policies:\n  - default: { available: local, busy: defer, offline: defer }",
        "queue: { shutdownGraceSeconds: 1 }",
        "",
      ].join("\n"),
    );
    const result = await runMain({
      EBBGATE_CONFIG: cfgFile,
      EBBGATE_DB: dbFile,
      LOG_LEVEL: "silent",
    });
    expect(result.code).toBe(0);
    if (result.code !== 0) return;
    const res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(runPayload({ runId: "run-live", agentId: "agent_x" })),
    });
    expect(res.status).toBe(202);
    await Promise.all([result.server.shutdown(), result.server.shutdown()]);
    expect(result.server.listening).toBe(false);

    const db = openDb(dbFile);
    expect(rowOf(db, "run-live").status).toBe("pending");
    db.close();
  });
});
