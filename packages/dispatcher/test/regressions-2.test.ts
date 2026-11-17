import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type Db, openDb } from "../src/db/index.js";
import { formatStartupError } from "../src/index.js";
import { createLogger } from "../src/logger.js";
import { createHttpPaperclipClient } from "../src/paperclip/client.js";
import type { PaperclipClient } from "../src/paperclip/types.js";
import { drainDeferred, persistDeferred } from "../src/services/queue.js";
import { insertRunning } from "../src/services/runs.js";
import { runPayload, testConfig } from "./helpers/config.js";
import { createFakePaperclip, type FakePaperclip } from "./helpers/fake-paperclip.js";
import { type FakeRunner, startFakeRunner } from "./helpers/fake-runner.js";

const silent = createLogger("silent");
const quietNotifier = { notify: async () => {} };
const T0 = new Date("2026-11-17T08:00:00.000Z");

function defer(db: Db, runId: string, issueId: string, createdAt: Date) {
  persistDeferred(db, {
    runId,
    issueId,
    agentId: "agent_inbox",
    companyId: "c",
    tier: "private",
    reason: "test",
    payload: {},
    createdAt: createdAt.toISOString(),
  });
}

const statusOf = (db: Db, runId: string) =>
  (db.prepare(`SELECT status FROM deferred WHERE run_id = ?`).get(runId) as { status: string })
    .status;

describe("deferred queue (second review round)", () => {
  let db: Db;
  let paperclip: FakePaperclip;
  beforeEach(() => {
    db = openDb(":memory:");
    paperclip = createFakePaperclip();
  });
  afterEach(() => db.close());

  const drain = (clock: () => Date, extra: Partial<Parameters<typeof drainDeferred>[0]> = {}) =>
    drainDeferred({
      db,
      paperclip,
      notifier: quietNotifier,
      logger: silent,
      clock,
      deferredMaxAgeHours: 72,
      drainConcurrency: 2,
      ...extra,
    });

  it("keeps duplicate rows pending until the covering wake succeeds", async () => {
    defer(db, "run-old", "issue-1", T0);
    defer(db, "run-new", "issue-1", new Date(T0.getTime() + 60_000));

    paperclip.failNextWakes = 1;
    await drain(() => new Date(T0.getTime() + 120_000));
    expect(statusOf(db, "run-old")).toBe("pending");
    expect(statusOf(db, "run-new")).toBe("pending"); // still retryable

    await drain(() => new Date(T0.getTime() + 180_000));
    expect(paperclip.wakes).toHaveLength(1); // one wake covers the issue
    expect(statusOf(db, "run-old")).toBe("done");
    expect(statusOf(db, "run-new")).toBe("done");
  });

  it("still wakes the newer duplicate when the older row expires after a failed wake", async () => {
    const maxAgeHours = 1;
    defer(db, "run-old", "issue-1", T0);
    defer(db, "run-new", "issue-1", new Date(T0.getTime() + 50 * 60_000));

    paperclip.failNextWakes = 1;
    await drain(() => new Date(T0.getTime() + 59 * 60_000), { deferredMaxAgeHours: maxAgeHours });
    expect(paperclip.wakes).toHaveLength(0);

    // The old row is now past its age limit and expires; the newer one must still be woken.
    await drain(() => new Date(T0.getTime() + 61 * 60_000), { deferredMaxAgeHours: maxAgeHours });
    expect(statusOf(db, "run-old")).toBe("expired");
    expect(statusOf(db, "run-new")).toBe("done");
    expect(paperclip.wakes.map((w) => w.idempotencyKey)).toEqual(["ebbgate-defer-run-new"]);
  });

  it("timestamps each claim when it is acquired, not when the drain started", async () => {
    for (const id of ["a", "b", "c"]) defer(db, `run-${id}`, `issue-${id}`, T0);
    const clock = { now: new Date(T0.getTime() + 60_000) };
    const claimedAt: Record<string, string> = {};
    const slow: PaperclipClient = {
      ...paperclip,
      async wakeAgent(args) {
        const row = db
          .prepare(`SELECT claimed_at FROM deferred WHERE issue_id = ?`)
          .get(args.issueId) as { claimed_at: string };
        claimedAt[args.issueId ?? ""] = row.claimed_at;
        clock.now = new Date(clock.now.getTime() + 2 * 60_000); // each wake takes 2 minutes
      },
    };
    await drain(() => clock.now, { paperclip: slow, drainConcurrency: 1 });
    const start = T0.getTime() + 60_000;
    expect(new Date(claimedAt["issue-a"] ?? "").getTime()).toBe(start);
    expect(new Date(claimedAt["issue-b"] ?? "").getTime()).toBe(start + 2 * 60_000);
    expect(new Date(claimedAt["issue-c"] ?? "").getTime()).toBe(start + 4 * 60_000);
  });
});

describe("startup replay of interrupted runs", () => {
  let db: Db;
  let cloud: FakeRunner;
  let local: FakeRunner;
  let paperclip: FakePaperclip;
  beforeEach(async () => {
    db = openDb(":memory:");
    cloud = await startFakeRunner("cloud");
    local = await startFakeRunner("local");
    paperclip = createFakePaperclip();
  });
  afterEach(async () => {
    db.close();
    await cloud.close();
    await local.close();
  });

  /** A run the previous process marked interrupted, then crashed before recovering. */
  function crashedInterruption(runId: string, agentId: string, labels: string[] = []) {
    insertRunning(db, {
      runId,
      issueId: `issue-${runId}`,
      agentId,
      companyId: "company_test",
      target: "local",
      nodeId: "mini",
      priority: "normal",
      startedAt: T0.toISOString(),
      payload: runPayload({ runId, agentId, issueId: `issue-${runId}`, labels }),
    });
    db.prepare(
      `UPDATE runs SET status = 'interrupted', finished_at = ?, recovered_at = NULL WHERE run_id = ?`,
    ).run(T0.toISOString(), runId);
  }

  function restart() {
    return createApp({
      config: testConfig({ localRunner: local.url, cloudRunner: cloud.url }),
      db,
      paperclip,
      logger: silent,
      notifier: quietNotifier,
      now: () => new Date(T0.getTime() + 60_000),
    });
  }

  it("re-decides runs left unrecovered by a crash, exactly once", async () => {
    crashedInterruption("run-internal", "agent_ops");
    crashedInterruption("run-private", "agent_inbox");

    const { presence } = restart();
    await presence.recoverInterrupted();

    // Internal work moves to the cloud; private work waits. Nothing goes to the local node.
    expect(cloud.hits).toHaveLength(1);
    expect(local.hits).toHaveLength(0);
    const deferred = db.prepare(`SELECT run_id FROM deferred`).all() as { run_id: string }[];
    expect(deferred.map((d) => d.run_id)).toEqual(["run-private:redecide"]);
    const unrecovered = db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE status = 'interrupted' AND recovered_at IS NULL`,
      )
      .get() as { n: number };
    expect(unrecovered.n).toBe(0);

    // A second pass (or a tick) does not replay them again.
    await presence.recoverInterrupted();
    await restart().tick();
    expect(cloud.hits).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM deferred`).get()).toEqual({ n: 1 });
  });

  it("keeps recovering after an earlier pass that had nothing to do", async () => {
    const { presence } = restart();
    await presence.recoverInterrupted(); // empty pass
    await presence.recoverInterrupted(); // and another
    crashedInterruption("run-later", "agent_ops");
    await presence.recoverInterrupted();
    expect(cloud.hits).toHaveLength(1);
  });

  it("keeps draining after an earlier drain that had nothing to do", async () => {
    const { presence } = restart();
    await presence.drain(); // empty
    persistDeferred(db, {
      runId: "run-q",
      issueId: "issue-q",
      agentId: "agent_inbox",
      companyId: "c",
      tier: "private",
      reason: "test",
      payload: {},
      createdAt: T0.toISOString(),
    });
    await presence.drain();
    expect(paperclip.wakes).toHaveLength(1);
  });

  it("the ticker also picks up unrecovered runs", async () => {
    crashedInterruption("run-tick", "agent_ops");
    const { tick } = restart();
    await tick();
    expect(cloud.hits).toHaveLength(1);
  });
});

describe("Paperclip client hygiene", () => {
  it("times out a stalled request", async () => {
    const hang = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const client = createHttpPaperclipClient({
      apiUrl: "http://paperclip.test",
      apiKey: "k",
      fetch: hang,
      timeoutMs: 50,
    });
    const started = Date.now();
    await expect(client.wakeAgent({ agentId: "a", reason: "r" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("releases response bodies it does not read, on success and failure", async () => {
    let cancelled = 0;
    const bodyResponse = (status: number) =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new TextEncoder().encode("{}"));
          },
          cancel() {
            cancelled += 1;
          },
        }),
        { status },
      );
    let next = 200;
    const fetchFn = (async () => bodyResponse(next)) as typeof fetch;
    const client = createHttpPaperclipClient({
      apiUrl: "http://p.test",
      apiKey: "k",
      fetch: fetchFn,
    });

    await client.wakeAgent({ agentId: "a", reason: "r" });
    await client.commentOnIssue("i", "hello");
    next = 500;
    await expect(client.wakeAgent({ agentId: "a", reason: "r" })).rejects.toThrow(/500/);
    await expect(client.commentOnIssue("i", "hello")).rejects.toThrow(/500/);
    expect(cancelled).toBe(4);
  });
});

describe("startup errors", () => {
  it("prints the message only", () => {
    const err = new Error("Invalid Ebbgate config");
    expect(formatStartupError(err)).toBe("ebbgate: Invalid Ebbgate config");
    expect(formatStartupError("weird")).toBe("ebbgate: startup failed");
  });
});
