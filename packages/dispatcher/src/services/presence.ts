import {
  decide,
  deriveState,
  type EbbgateConfig,
  type NodeStatus,
  type PresenceMode,
  type PresenceReport,
  type PresenceState,
  resolveTier,
} from "@ebbgate/core";
import type { Db } from "../db/index.js";
import type { Logger } from "../logger.js";
import type { PaperclipClient } from "../paperclip/types.js";
import type { Notifier } from "./notifier.js";
import { drainDeferred, persistDeferred } from "./queue.js";
import { forwardToRunner } from "./runner.js";
import { insertRunning, listRunningOnNode, markRunStatus, recordDecision } from "./runs.js";

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
}): PresenceService {
  const { db, config, paperclip, notifier, logger, now } = deps;
  const fetchFn = deps.fetch ?? fetch;

  function ensureConfiguredNodes(): void {
    const at = now().toISOString();
    for (const id of Object.keys(config.nodes)) {
      const existing = db.prepare(`SELECT id FROM nodes WHERE id = ?`).get(id);
      if (!existing) {
        db.prepare(
          `INSERT INTO nodes (id, state, mode, last_seen_at, report_json, updated_at)
           VALUES (?, 'offline', 'auto', NULL, NULL, ?)`,
        ).run(id, at);
      }
    }
  }

  function readRow(id: string): NodeRow | undefined {
    return db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as NodeRow | undefined;
  }

  function listNodeStatuses(): NodeStatus[] {
    const rows = db.prepare(`SELECT * FROM nodes`).all() as NodeRow[];
    return rows.filter((r) => config.nodes[r.id] !== undefined).map((r) => rowToStatus(r));
  }

  function rowToStatus(row: NodeRow): NodeStatus {
    const report = row.report_json
      ? ({ ...JSON.parse(row.report_json), mode: row.mode } as PresenceReport)
      : null;
    return {
      node: row.id,
      state: row.state,
      lastSeenAt: row.last_seen_at,
      report,
    };
  }

  async function transition(
    nodeId: string,
    prev: PresenceState,
    next: PresenceState,
  ): Promise<void> {
    if (prev === next) return;

    if ((prev === "offline" || prev === "busy") && next === "available") {
      await notifier.notify("node_online", nodeId, `node ${nodeId} is available`);
      await drainDeferred({
        db,
        paperclip,
        notifier,
        logger,
        now: now(),
        deferredMaxAgeHours: config.presence.deferredMaxAgeHours,
        drainConcurrency: config.presence.drainConcurrency,
      });
    }

    if (prev === "available" && next === "offline") {
      await notifier.notify("node_offline", nodeId, `node ${nodeId} went offline`);
      await handleInterruptedRuns(nodeId);
    }
  }

  async function handleInterruptedRuns(nodeId: string): Promise<void> {
    const running = listRunningOnNode(db, nodeId);
    for (const run of running) {
      const finishedAt = now().toISOString();
      markRunStatus(db, run.run_id, "interrupted", finishedAt);
      await notifier.notify(
        "run_interrupted",
        nodeId,
        `run ${run.run_id} interrupted on ${nodeId}`,
      );

      let payload: unknown;
      try {
        payload = JSON.parse(run.payload_json);
      } catch {
        logger.warn({ runId: run.run_id }, "interrupted run had invalid payload_json");
        continue;
      }

      const tier = resolveTier(run.agent_id, config);
      const task = {
        runId: run.run_id,
        agentId: run.agent_id,
        companyId: run.company_id,
        ...(run.issue_id ? { issueId: run.issue_id } : {}),
        tier,
        labels: [],
      };

      // Re-decide with this node offline (other nodes may still be up).
      const nodes = listNodeStatuses().map((n) =>
        n.node === nodeId ? { ...n, state: "offline" as const } : n,
      );
      const decision = decide(task, nodes, config);
      recordDecision(db, {
        runId: run.run_id,
        agentId: run.agent_id,
        ...(run.issue_id ? { issueId: run.issue_id } : {}),
        tier,
        decision,
        decidedAt: finishedAt,
      });

      if (decision.action === "defer") {
        persistDeferred(db, {
          runId: `${run.run_id}:redecide`,
          ...(run.issue_id ? { issueId: run.issue_id } : {}),
          agentId: run.agent_id,
          companyId: run.company_id,
          tier,
          reason: decision.reason,
          payload,
          createdAt: finishedAt,
        });
        if (decision.notify) {
          await notifier.notify("task_deferred", nodeId, `re-deferred ${run.run_id}`);
        }
        if (run.issue_id) {
          try {
            await paperclip.commentOnIssue(
              run.issue_id,
              "Ebbgate: local node dropped; deferred until a local node returns (waiting-for-local).",
            );
            await paperclip.addLabel(run.issue_id, "waiting-for-local");
          } catch (err) {
            logger.warn({ err: String(err) }, "paperclip notify on re-defer failed");
          }
        }
      } else if (decision.action === "cloud") {
        insertRunning(db, {
          runId: `${run.run_id}:cloud`,
          ...(run.issue_id ? { issueId: run.issue_id } : {}),
          agentId: run.agent_id,
          companyId: run.company_id,
          target: "cloud",
          startedAt: finishedAt,
          payload,
        });
        try {
          await forwardToRunner(config.cloud.runner, payload, new Headers(), fetchFn);
          markRunStatus(db, `${run.run_id}:cloud`, "completed", now().toISOString());
        } catch (err) {
          logger.warn({ err: String(err) }, "cloud re-forward failed");
          markRunStatus(db, `${run.run_id}:cloud`, "failed", now().toISOString());
        }
      } else if (decision.action === "local") {
        insertRunning(db, {
          runId: `${run.run_id}:local`,
          ...(run.issue_id ? { issueId: run.issue_id } : {}),
          agentId: run.agent_id,
          companyId: run.company_id,
          target: "local",
          nodeId: decision.node,
          priority: decision.priority,
          startedAt: finishedAt,
          payload,
        });
        const runner = config.nodes[decision.node]?.runner;
        if (runner) {
          try {
            await forwardToRunner(runner, payload, new Headers(), fetchFn);
            markRunStatus(db, `${run.run_id}:local`, "completed", now().toISOString());
          } catch (err) {
            logger.warn({ err: String(err) }, "local re-forward failed");
            markRunStatus(db, `${run.run_id}:local`, "failed", now().toISOString());
          }
        }
      }
    }
  }

  async function writeState(
    nodeId: string,
    mode: PresenceMode,
    lastSeenAt: string | null,
    report: PresenceReport | null,
  ): Promise<void> {
    const prev = readRow(nodeId);
    const prevState: PresenceState = prev?.state ?? "offline";
    const nextState = deriveState(
      report ? { ...report, mode } : null,
      lastSeenAt,
      now(),
      config.presence.offlineAfterSeconds,
    );
    const at = now().toISOString();
    db.prepare(
      `INSERT INTO nodes (id, state, mode, last_seen_at, report_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         mode = excluded.mode,
         last_seen_at = excluded.last_seen_at,
         report_json = excluded.report_json,
         updated_at = excluded.updated_at`,
    ).run(nodeId, nextState, mode, lastSeenAt, report ? JSON.stringify(report) : null, at);
    await transition(nodeId, prevState, nextState);
  }

  return {
    ensureConfiguredNodes,
    listNodeStatuses,

    async applyReport(report: PresenceReport): Promise<void> {
      if (!config.nodes[report.node]) {
        throw new Error(`unknown node: ${report.node}`);
      }
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
      const rows = db.prepare(`SELECT * FROM nodes`).all() as NodeRow[];
      for (const row of rows) {
        if (config.nodes[row.id] === undefined) continue;
        const report = row.report_json ? (JSON.parse(row.report_json) as PresenceReport) : null;
        const next = deriveState(
          report ? { ...report, mode: row.mode } : null,
          row.last_seen_at,
          now(),
          config.presence.offlineAfterSeconds,
        );
        if (next !== row.state) {
          db.prepare(`UPDATE nodes SET state = ?, updated_at = ? WHERE id = ?`).run(
            next,
            now().toISOString(),
            row.id,
          );
          await transition(row.id, row.state, next);
        }
      }
    },
  };
}
