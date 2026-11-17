import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type Db, openDb } from "../src/db/index.js";
import { runMain } from "../src/index.js";
import { createLogger } from "../src/logger.js";
import { drainDeferred, persistDeferred } from "../src/services/queue.js";
import { insertRunning, markDispatched } from "../src/services/runs.js";
import { NODE_TOKEN, presenceBody, runPayload, testConfig } from "./helpers/config.js";
import { createFakePaperclip, type FakePaperclip } from "./helpers/fake-paperclip.js";
import { type FakeRunner, startFakeRunner } from "./helpers/fake-runner.js";

const silent = createLogger("silent");
const quietNotifier = { notify: async () => {} };
const T0 = new Date("2026-11-17T10:00:00.000Z");

type RunRowLite = { status: string; recovered_at: string | null; dispatched_at: string | null };

describe("third review round", () => {
  let db: Db;
  let local: FakeRunner;
  let second: FakeRunner;
  let cloud: FakeRunner;
  let paperclip: FakePaperclip;
  let clock: { now: Date };

  beforeEach(async () => {
    db = openDb(":memory:");
    local = await startFakeRunner("mini");
    second = await startFakeRunner("mbp");
    cloud = await startFakeRunner("cloud");
    paperclip = createFakePaperclip();
    clock = { now: T0 };
  });

  afterEach(async () => {
    db.close();
    await Promise.all([local.close(), second.close(), cloud.close()]);
  });

  function app(extra: { runnerTimeoutMs?: number } = {}) {
    return createApp({
      config: testConfig({
        localRunner: local.url,
        cloudRunner: cloud.url,
        secondRunner: second.url,
        offlineAfterSeconds: 90,
        ...extra,
      }),
      db,
      paperclip,
      logger: silent,
      notifier: quietNotifier,
      now: () => clock.now,
    });
  }

  const row = (runId: string) =>
    db
      .prepare(`SELECT status, recovered_at, dispatched_at FROM runs WHERE run_id = ?`)
      .get(runId) as RunRowLite | undefined;

  /** A run row as a previous process left it. */
  function leftover(
    runId: string,
    opts: {
      agentId?: string;
      origin: "ingress" | "replacement";
      target?: "local" | "cloud";
      dispatched: boolean;
    },
  ) {
    const agentId = opts.agentId ?? "agent_ops";
    insertRunning(db, {
      runId,
      issueId: `issue-${runId}`,
      agentId,
      companyId: "company_test",
      target: opts.target ?? "cloud",
      ...(opts.target === "local" ? { nodeId: "mini", priority: "normal" as const } : {}),
      startedAt: T0.toISOString(),
      payload: runPayload({ runId, agentId, issueId: `issue-${runId}` }),
      origin: opts.origin,
    });
    if (opts.dispatched) markDispatched(db, runId, T0.toISOString());
  }

  /* -------------------------------------------------------------- */
  /* Node availability is derived from heartbeats at decision time   */
  /* -------------------------------------------------------------- */

  it("never routes recovery to a node whose heartbeat has expired, even if its stored state says available", async () => {
    // mbp reported long ago; its row still says "available" because no tick ran yet.
    db.prepare(
      `INSERT INTO nodes (id, state, mode, last_seen_at, report_json, updated_at)
       VALUES ('mbp', 'available', 'auto', ?, ?, ?)`,
    ).run(
      new Date(T0.getTime() - 10 * 60_000).toISOString(),
      JSON.stringify({ ...presenceBody(), node: "mbp" }),
      T0.toISOString(),
    );
    leftover("run-private", {
      agentId: "agent_inbox",
      origin: "ingress",
      target: "local",
      dispatched: true,
    });
    db.prepare(
      `UPDATE runs SET status = 'interrupted', recovered_at = NULL, interrupted_reason = 'node_offline' WHERE run_id = 'run-private'`,
    ).run();

    await app().presence.recoverInterrupted();

    expect(second.hits).toHaveLength(0); // the stale node was not chosen
    expect(cloud.hits).toHaveLength(0); // and private work never goes to the cloud
    expect(db.prepare(`SELECT run_id FROM deferred`).all()).toEqual([
      { run_id: "run-private:redecide" },
    ]);
  });

  it("reports live heartbeat-derived state from listNodeStatuses", async () => {
    const { presence } = app();
    db.prepare(
      `UPDATE nodes SET state = 'available', last_seen_at = ?, report_json = ?, updated_at = ?
       WHERE id = 'mbp'`,
    ).run(
      new Date(T0.getTime() - 10 * 60_000).toISOString(),
      JSON.stringify({ ...presenceBody(), node: "mbp" }),
      T0.toISOString(),
    );
    expect(presence.listNodeStatuses().find((n) => n.node === "mbp")?.state).toBe("offline");
  });

  /* -------------------------------------------------------------- */
  /* Runner forwards are bounded, including the body                 */
  /* -------------------------------------------------------------- */

  it("settles a replacement as failed when the runner stalls mid-body", async () => {
    cloud.stallBody = true;
    leftover("run-stall", { origin: "replacement", dispatched: false });
    const started = Date.now();
    await app({ runnerTimeoutMs: 1_000 }).presence.reconcileAfterRestart();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(row("run-stall:cloud")?.status).toBe("failed");
  });

  it("bounds ingress forwards too", async () => {
    cloud.stallBody = true;
    const { app: http } = app({ runnerTimeoutMs: 1_000 });
    const res = await http.request("/run", {
      method: "POST",
      headers: {
        authorization: "Bearer shared-secret-0123456789abcdef",
        "content-type": "application/json",
      },
      body: JSON.stringify(runPayload({ runId: "run-in-stall", agentId: "agent_research" })),
    });
    expect(res.status).toBe(502);
    expect(row("run-in-stall")?.status).toBe("failed");
  });

  /* -------------------------------------------------------------- */
  /* Crash-safe dispatch                                              */
  /* -------------------------------------------------------------- */

  it("re-dispatches a replacement that was recorded but never sent (crash before the POST)", async () => {
    leftover("run-a:cloud", { origin: "replacement", dispatched: false });
    const report = await app().presence.reconcileAfterRestart();

    expect(report.neverDispatched).toEqual(["run-a:cloud"]);
    expect(cloud.hits).toHaveLength(1);
    expect(cloud.headers[0]?.["idempotency-key"]).toBe("ebbgate-run-run-a");
    expect(row("run-a:cloud")?.status).toBe("interrupted");
    expect(row("run-a:cloud:cloud")?.status).toBe("completed");

    // Exactly once: a second restart finds nothing left to do.
    const again = await app().presence.reconcileAfterRestart();
    expect(again).toEqual({ failedIngress: [], neverDispatched: [], outcomeUnknown: [] });
    expect(cloud.hits).toHaveLength(1);
  });

  it("re-sends a replacement with unknown outcome under the same Idempotency-Key", async () => {
    leftover("run-b:cloud", { origin: "replacement", dispatched: true });
    const report = await app().presence.reconcileAfterRestart();
    expect(report.outcomeUnknown).toEqual(["run-b:cloud"]);
    expect(cloud.headers[0]?.["idempotency-key"]).toBe("ebbgate-run-run-b");
  });

  it("closes orphaned ingress runs as failed without re-dispatching (Paperclip retries them)", async () => {
    leftover("run-c", { origin: "ingress", dispatched: true });
    leftover("run-d", { origin: "ingress", dispatched: false });
    const report = await app().presence.reconcileAfterRestart();
    expect(report.failedIngress.sort()).toEqual(["run-c", "run-d"]);
    expect(row("run-c")?.status).toBe("failed");
    expect(cloud.hits).toHaveLength(0);
  });

  it("marks runs dispatched before sending them", async () => {
    const { app: http } = app();
    await http.request("/presence", {
      method: "POST",
      headers: { authorization: `Bearer ${NODE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(presenceBody()),
    });
    await http.request("/run", {
      method: "POST",
      headers: {
        authorization: "Bearer shared-secret-0123456789abcdef",
        "content-type": "application/json",
      },
      body: JSON.stringify(runPayload({ runId: "run-e", agentId: "agent_inbox" })),
    });
    expect(row("run-e")?.dispatched_at).toBeTruthy();
    expect(local.headers[0]?.["idempotency-key"]).toBe("ebbgate-run-run-e");
  });

  /* -------------------------------------------------------------- */
  /* Expiry is re-checked when each item is claimed                  */
  /* -------------------------------------------------------------- */

  it("expires an item that crosses the age limit while earlier wakes run", async () => {
    const created = new Date(T0.getTime() - (60 * 60_000 - 1_000)); // 59m59s old
    for (const id of ["a", "b"]) {
      persistDeferred(db, {
        runId: `run-${id}`,
        issueId: `issue-${id}`,
        agentId: "agent_inbox",
        companyId: "c",
        tier: "private",
        reason: "test",
        payload: {},
        createdAt: created.toISOString(),
      });
    }
    const slow = {
      ...paperclip,
      async wakeAgent(args: Parameters<FakePaperclip["wakeAgent"]>[0]) {
        await paperclip.wakeAgent(args);
        clock.now = new Date(clock.now.getTime() + 2_000); // each wake takes 2 s
      },
    };
    const result = await drainDeferred({
      db,
      paperclip: slow,
      notifier: quietNotifier,
      logger: silent,
      clock: () => clock.now,
      deferredMaxAgeHours: 1,
      drainConcurrency: 1,
    });
    expect(result).toMatchObject({ woken: 1, expired: 1 });
    expect(paperclip.wakes.map((w) => w.issueId)).toEqual(["issue-a"]);
  });
});

describe("startup errors on stderr", () => {
  it("never print config content, stack traces or secrets", async () => {
    const secret = "sk-live-STDERR-SECRET-123456789";
    const dir = mkdtempSync(join(tmpdir(), "ebbgate-stderr-"));
    try {
      const config = join(dir, "ebbgate.yaml");
      writeFileSync(config, `paperclip:\n  apiKey: "${secret}\n  broken: [\n`);
      const lines: string[] = [];
      const result = await runMain(
        { EBBGATE_CONFIG: config, EBBGATE_DB: join(dir, "x", "e.db") },
        (line) => lines.push(line),
      );
      const stderr = lines.join("\n");
      expect(result.code).toBe(1);
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain("STDERR-SECRET");
      expect(stderr).toMatch(/YAML parse error \(\w+\)/);
      expect(stderr).not.toMatch(/\n\s+at /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leak env-var secrets from validation errors either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ebbgate-stderr-"));
    try {
      const config = join(dir, "ebbgate.yaml");
      // Valid YAML, invalid config: a short token pulled from the environment.
      writeFileSync(
        config,
        `server: { publicUrl: "http://x:1" }\nnodes:\n  mini: { runner: "http://m:8787", token: "\${TOK}" }\n` +
          `cloud: { runner: "http://c:1" }\npaperclip: { apiUrl: "http://p:1", apiKey: k, sharedSecret: "\${TOK}" }\n` +
          "policies:\n  - default: { available: defer, busy: defer, offline: defer }\n",
      );
      const lines: string[] = [];
      const result = await runMain({ EBBGATE_CONFIG: config, TOK: "tiny-sec" }, (l) =>
        lines.push(l),
      );
      expect(result.code).toBe(1);
      expect(lines.join("\n")).not.toContain("tiny-sec");
      expect(lines.join("\n")).toMatch(/at least 16 characters/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
