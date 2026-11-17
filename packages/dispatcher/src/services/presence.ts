import {
  decide,
  deriveState,
  type EbbgateConfig,
  type NodeStatus,
  type PresenceMode,
  type PresenceReport,
  type PresenceState,
  resolveTier,
  type TaskContext,
  type Tier,
} from "@ebbgate/core";
import type { Db } from "../db/index.js";
import { type DemoWriter, logDemoDecision, logDemoPresence } from "../demo.js";
import type { Logger } from "../logger.js";
import type { PaperclipClient } from "../paperclip/types.js";
import type { Notifier } from "./notifier.js";
import {
  countPendingDeferred,
  drainDeferred,
  persistDeferred,
  releaseStaleClaims,
} from "./queue.js";
import { forwardToRunner, idempotencyKeyFor } from "./runner.js";
import {
  claimInterruptedRuns,
  finishRun,
  insertRunning,
  listUnrecoveredRuns,
  markDispatched,
  markRecovered,
  type OrphanReport,
  type RunRow,
  reconcileOrphanedRuns,
  recordDecision,
} from "./runs.js";

export interface NodeRow {
  id: string;
  state: PresenceState;
  mode: PresenceMode;
  last_seen_at: string | null;
  report_json: string | null;
  updated_at: string;
}

export interface PresenceService {
  applyReport(report: PresenceReport): Promise<void>;
  setMode(nodeId: string, mode: PresenceMode): Promise<void>;
  tick(): Promise<void>;
  /** Drain the deferred queue now. Concurrent calls share one serialized drain. */
  drain(): Promise<void>;
  /**
   * Re-decide every interrupted run whose recovery is not yet recorded. Called on
   * the offline transition, at startup and on every tick; passes are serialized.
   */
  recoverInterrupted(): Promise<void>;
  /**
   * Startup only, before listening: close out runs a previous process left
   * `running`, then recover them. Returns what was found.
   */
  reconcileAfterRestart(): Promise<OrphanReport>;
  listNodeStatuses(): NodeStatus[];
  ensureConfiguredNodes(): void;
}

export function createPresenceService(deps: {
  db: Db;
  config: EbbgateConfig;
  paperclip: PaperclipClient;
  notifier: Notifier;
  logger: Logger;
  now: () => Date;
  fetch?: typeof fetch;
  demo?: DemoWriter;
}): PresenceService {
  const { db, config, paperclip, notifier, logger, now } = deps;
  const fetchFn = deps.fetch ?? fetch;
  const demo = deps.demo ?? (() => {});

  function ensureConfiguredNodes(): void {
    const at = now().toISOString();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO nodes (id, state, mode, last_seen_at, report_json, updated_at)
       VALUES (?, 'offline', 'auto', NULL, NULL, ?)`,
    );
    for (const id of Object.keys(config.nodes)) insert.run(id, at);
  }

  function readRow(id: string): NodeRow | undefined {
    return db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as NodeRow | undefined;
  }

  /**
   * Every configured node with its state derived from its heartbeat *now*, using
   * the same freshness rules as tick(). The stored `state` column can be stale
   * (for example right after a restart, before the first tick), so routing never
   * trusts it.
   */
  function listNodeStatuses(): NodeStatus[] {
    const rows = db.prepare(`SELECT * FROM nodes`).all() as NodeRow[];
    const at = now();
    return rows
      .filter((r) => config.nodes[r.id] !== undefined)
      .map((r) => {
        const status = rowToStatus(r);
        return {
          ...status,
          state: deriveState(
            status.report,
            r.last_seen_at,
            at,
            config.presence.offlineAfterSeconds,
          ),
        };
      });
  }

  function rowToStatus(row: NodeRow): NodeStatus {
    const report = row.report_json
      ? ({ ...JSON.parse(row.report_json), mode: row.mode } as PresenceReport)
      : null;
    return { node: row.id, state: row.state, lastSeenAt: row.last_seen_at, report };
  }

  /* ---------------------------------------------------------------- */
  /* Deferred queue: one drain at a time                               */
  /* ---------------------------------------------------------------- */

  let draining: Promise<void> | null = null;
  let drainRequested = false;

  function drain(): Promise<void> {
    drainRequested = true;
    if (draining) return draining;
    // Start on a later microtask, so `draining` is assigned before the pass can
    // finish (a pass with no awaits would otherwise clear it first and leave a
    // settled promise behind, silently disabling every later drain).
    draining = Promise.resolve().then(async () => {
      try {
        while (drainRequested) {
          drainRequested = false;
          await drainDeferred({
            db,
            paperclip,
            notifier,
            logger,
            clock: now,
            deferredMaxAgeHours: config.presence.deferredMaxAgeHours,
            drainConcurrency: config.presence.drainConcurrency,
          });
        }
      } finally {
        draining = null;
      }
    });
    return draining;
  }

  /* ---------------------------------------------------------------- */
  /* State transitions                                                 */
  /* ---------------------------------------------------------------- */

  async function transition(
    nodeId: string,
    prev: PresenceState,
    next: PresenceState,
  ): Promise<void> {
    if (prev === next) return;
    logDemoPresence(demo, { node: nodeId, from: prev, to: next });

    if (next === "offline") {
      // Claim the affected attempts synchronously, before any await, so runs
      // accepted after the node recovers can never be swept up by this transition.
      // Their recovery is tracked durably (recovered_at), so it survives a crash.
      claimInterruptedRuns(db, nodeId, now().toISOString());
      await notifier.notify("node_offline", nodeId, `node ${nodeId} went offline`);
      await recoverInterrupted();
      return;
    }

    if (next === "available") {
      await notifier.notify("node_online", nodeId, `node ${nodeId} is available`);
      await drain();
    }
  }

  /** Labels and tier for a recovered run, parsed exactly as ingress does. Fails closed. */
  function recoveryTask(run: RunRow, payload: unknown): TaskContext {
    let labels: string[] = [];
    let tier: Tier = resolveTier(run.agent_id, config);
    try {
      labels = paperclip.parseRun(payload, new Headers()).labels;
    } catch (err) {
      // Without labels we cannot know whether a label rule (e.g. local-files)
      // applies, so treat the task as private: it can wait, but never leak.
      logger.warn(
        { runId: run.run_id, err: String(err) },
        "could not re-parse stored payload; treating as private",
      );
      tier = "private";
    }
    return {
      runId: run.run_id,
      agentId: run.agent_id,
      companyId: run.company_id,
      ...(run.issue_id ? { issueId: run.issue_id } : {}),
      tier,
      labels,
    };
  }

  let recovering: Promise<void> | null = null;
  let recoverRequested = false;

  function recoverInterrupted(): Promise<void> {
    recoverRequested = true;
    if (recovering) return recovering;
    // Same pattern as drain(): start asynchronously so an empty pass cannot leave
    // a settled promise in `recovering`.
    recovering = Promise.resolve().then(async () => {
      try {
        while (recoverRequested) {
          recoverRequested = false;
          for (const run of listUnrecoveredRuns(db)) await recoverRun(run);
        }
      } finally {
        recovering = null;
      }
    });
    return recovering;
  }

async function recoverRun(run: RunRow): Promise<void> {
    const nodeId = run.node_id;
    await notifier.notify(
      "run_interrupted",
      nodeId,
      `run ${run.run_id} interrupted on ${nodeId ?? "unknown node"}`,
    );

    let payload: unknown;
    try {
      payload = JSON.parse(run.payload_json);
    } catch {
      logger.warn({ runId: run.run_id }, "interrupted run had invalid payload_json; not replayed");
      markRecovered(db, run.run_id, now().toISOString());
      return;
    }

    const task = recoveryTask(run, payload);
    // Re-decide with every node's live state. If the run was lost because its node
    // dropped, that node also counts as offline even if a heartbeat is still fresh.
    const nodeDropped = run.interrupted_reason !== "dispatcher_restart";
    const nodes = listNodeStatuses().map((n) =>
      nodeDropped && n.node === nodeId ? { ...n, state: "offline" as const } : n,
    );
    const decision = decide(task, nodes, config);
    const decidedAt = now().toISOString();
    logDemoDecision(demo, { task, tier: task.tier, nodes, decision });

    if (decision.action === "defer") {
      // The deferred row and the recovery marker commit together.
      db.transaction(() => {
        recordDecision(db, {
          runId: run.run_id,
          agentId: run.agent_id,
          ...(run.issue_id ? { issueId: run.issue_id } : {}),
          tier: task.tier,
          decision,
          decidedAt,
        });
        persistDeferred(db, {
          runId: `${run.run_id}:redecide`,
          ...(run.issue_id ? { issueId: run.issue_id } : {}),
          agentId: run.agent_id,
          companyId: run.company_id,
          tier: task.tier,
          reason: decision.reason,
          payload,
          createdAt: decidedAt,
        });
        markRecovered(db, run.run_id, decidedAt);
      })();
      if (decision.notify) {
        await notifier.notify("task_deferred", nodeId, `re-deferred ${run.run_id}`);
      }
      if (run.issue_id) {
        try {
          await paperclip.commentOnIssue(
            run.issue_id,
            "Ebbgate: local node dropped; deferred until a local node returns (waiting-for-local).",
          );
          if (config.paperclip.labelDeferred) {
            await paperclip.addLabel(run.issue_id, "waiting-for-local");
          }
        } catch (err) {
          logger.warn({ err: String(err) }, "paperclip notify on re-defer failed");
        }
      }
      return;
    }

    const replacementId = `${run.run_id}:${decision.action}`;
    const runnerUrl =
      decision.action === "cloud" ? config.cloud.runner : config.nodes[decision.node]?.runner;
    if (!runnerUrl) {
      logger.error({ runId: run.run_id }, "no runner configured for re-decided target");
      return; // left unrecovered: retried on the next pass once config is fixed
    }

    // The replacement run and the recovery marker commit together.
    db.transaction(() => {
      recordDecision(db, {
        runId: run.run_id,
        agentId: run.agent_id,
        ...(run.issue_id ? { issueId: run.issue_id } : {}),
        tier: task.tier,
        decision,
        decidedAt,
      });
      insertRunning(db, {
        runId: replacementId,
        ...(run.issue_id ? { issueId: run.issue_id } : {}),
        agentId: run.agent_id,
        companyId: run.company_id,
        target: decision.action,
        ...(decision.action === "local"
          ? { nodeId: decision.node, priority: decision.priority }
          : {}),
        startedAt: decidedAt,
        payload,
        origin: "replacement",
      });
      markRecovered(db, run.run_id, decidedAt);
    })();

    try {
      markDispatched(db, replacementId, now().toISOString());
      const result = await forwardToRunner(runnerUrl, payload, new Headers(), fetchFn, {
        timeoutMs: config.server.runnerTimeoutMs,
        idempotencyKey: idempotencyKeyFor(run.run_id),
      });
      const ok = result.status >= 200 && result.status < 300;
      if (!ok) {
        logger.warn(
          { runId: replacementId, status: result.status },
          "replacement runner returned an error",
        );
      }
      finishRun(db, replacementId, ok ? "completed" : "failed", now().toISOString());
    } catch (err) {
      logger.warn({ err: String(err), runId: replacementId }, "replacement forward failed");
      finishRun(db, replacementId, "failed", now().toISOString());
    }
  }

  /**
   * Write a node's presence and derive its state. Read, derive and write are a
   * single synchronous block (no await in between), so no other writer can
   * interleave; only then is the transition handled.
   */
  async function writeState(
    nodeId: string,
    mode: PresenceMode,
    lastSeenAt: string | null,
    report: PresenceReport | null,
  ): Promise<void> {
    const prevState: PresenceState = readRow(nodeId)?.state ?? "offline";
    const nextState = deriveState(
      report ? { ...report, mode } : null,
      lastSeenAt,
      now(),
      config.presence.offlineAfterSeconds,
    );
    db.prepare(
      `INSERT INTO nodes (id, state, mode, last_seen_at, report_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         mode = excluded.mode,
         last_seen_at = excluded.last_seen_at,
         report_json = excluded.report_json,
         updated_at = excluded.updated_at`,
    ).run(
      nodeId,
      nextState,
      mode,
      lastSeenAt,
      report ? JSON.stringify(report) : null,
      now().toISOString(),
    );
    await transition(nodeId, prevState, nextState);
  }

  return {
    ensureConfiguredNodes,
    listNodeStatuses,
    drain,
    recoverInterrupted,

    async reconcileAfterRestart(): Promise<OrphanReport> {
      const report = reconcileOrphanedRuns(db, now().toISOString());
      if (report.failedIngress.length > 0) {
        logger.warn(
          { runs: report.failedIngress },
          "runs in flight at the last shutdown marked failed; Paperclip retries them on its next heartbeat",
        );
      }
      if (report.neverDispatched.length > 0) {
        logger.info(
          { runs: report.neverDispatched },
          "replacement runs never sent before the last shutdown; dispatching them now",
        );
      }
      if (report.outcomeUnknown.length > 0) {
        logger.warn(
          { runs: report.outcomeUnknown },
          "replacement runs with unknown outcome re-dispatched with the same Idempotency-Key (at-least-once)",
        );
      }
      await recoverInterrupted();
      return report;
    },

    async applyReport(report: PresenceReport): Promise<void> {
      if (!config.nodes[report.node]) throw new Error(`unknown node: ${report.node}`);
      await writeState(report.node, report.mode, now().toISOString(), report);
    },

    async setMode(nodeId: string, mode: PresenceMode): Promise<void> {
      if (!config.nodes[nodeId]) throw new Error(`unknown node: ${nodeId}`);
      const row = readRow(nodeId);
      const report = row?.report_json
        ? ({ ...JSON.parse(row.report_json), mode } as PresenceReport)
        : null;
      await writeState(nodeId, mode, row?.last_seen_at ?? null, report);
    },

    async tick(): Promise<void> {
      // Pick up interrupted runs left unrecovered (for example by a crash).
      if (listUnrecoveredRuns(db).length > 0) await recoverInterrupted();

      for (const id of Object.keys(config.nodes)) {
        // Re-read each row right before using it: earlier iterations await, and a
        // heartbeat may have landed in between. The conditional UPDATE only applies
        // if the row still has the heartbeat and state this decision was based on.
        const row = readRow(id);
        if (!row) continue;
        const report = row.report_json ? (JSON.parse(row.report_json) as PresenceReport) : null;
        const next = deriveState(
          report ? { ...report, mode: row.mode } : null,
          row.last_seen_at,
          now(),
          config.presence.offlineAfterSeconds,
        );
        if (next === row.state) continue;
        const applied = db
          .prepare(
            `UPDATE nodes SET state = ?, updated_at = ?
             WHERE id = ? AND state = ? AND last_seen_at IS ?`,
          )
          .run(next, now().toISOString(), id, row.state, row.last_seen_at).changes;
        if (applied === 1) await transition(id, row.state, next);
      }

      // Retry wakes that failed earlier, and recover claims abandoned by a crash,
      // without waiting for another transition. Expired claims are released here
      // first, so a stranded `waking` row is retried even when nothing else is pending.
      const anyAvailable = listNodeStatuses().some((n) => n.state === "available");
      if (!anyAvailable) return;
      releaseStaleClaims(db, now());
      if (countPendingDeferred(db) > 0) await drain();
    },
  };
}
