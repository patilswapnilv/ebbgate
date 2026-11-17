import type { Decision, Tier } from "@ebbgate/core";
import type { Db } from "../db/index.js";

export type RunStatus = "running" | "interrupted" | "completed" | "failed";
export type RunTarget = "local" | "cloud";

export interface RunRow {
  run_id: string;
  issue_id: string | null;
  agent_id: string;
  company_id: string;
  target: RunTarget;
  node_id: string | null;
  priority: "normal" | "low" | null;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  payload_json: string;
  recovered_at: string | null;
  origin: RunOrigin;
  dispatched_at: string | null;
  interrupted_reason: InterruptReason | null;
}

/** `ingress`: a Paperclip request is waiting on it. `replacement`: created by recovery. */
export type RunOrigin = "ingress" | "replacement";
export type InterruptReason = "node_offline" | "dispatcher_restart";

export function recordDecision(
  db: Db,
  args: {
    runId: string;
    agentId: string;
    issueId?: string;
    tier: Tier;
    decision: Decision;
    decidedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO decisions (run_id, agent_id, issue_id, tier, action, node_id, reason, rule_ref, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.runId,
    args.agentId,
    args.issueId ?? null,
    args.tier,
    args.decision.action,
    args.decision.action === "local" ? args.decision.node : null,
    args.decision.reason,
    String(args.decision.rule),
    args.decidedAt,
  );
}

export function insertRunning(
  db: Db,
  args: {
    runId: string;
    issueId?: string;
    agentId: string;
    companyId: string;
    target: RunTarget;
    nodeId?: string;
    priority?: "normal" | "low";
    startedAt: string;
    payload: unknown;
    origin?: RunOrigin;
  },
): void {
  db.prepare(
    `INSERT INTO runs (run_id, issue_id, agent_id, company_id, target, node_id, priority, status, started_at, finished_at, payload_json, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, ?, ?)`,
  ).run(
    args.runId,
    args.issueId ?? null,
    args.agentId,
    args.companyId,
    args.target,
    args.nodeId ?? null,
    args.priority ?? null,
    args.startedAt,
    JSON.stringify(args.payload),
    args.origin ?? "ingress",
  );
}

/**
 * Record that the request to the runner is about to be sent. A run that is
 * `running` with no `dispatched_at` after a restart was never sent.
 */
export function markDispatched(db: Db, runId: string, at: string): void {
  db.prepare(`UPDATE runs SET dispatched_at = ? WHERE run_id = ? AND dispatched_at IS NULL`).run(
    at,
    runId,
  );
}

/**
 * Finish a run, but only if it is still `running`. Returns false when another
 * path (for example interruption recovery) already moved it on, so a late
 * response can never overwrite an `interrupted` status.
 */
export function finishRun(
  db: Db,
  runId: string,
  status: Exclude<RunStatus, "running">,
  finishedAt: string,
): boolean {
  const res = db
    .prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ? AND status = 'running'`)
    .run(status, finishedAt, runId);
  return res.changes === 1;
}

/**
 * Atomically mark every run still `running` on a node as `interrupted` and
 * return exactly those rows. Runs accepted later (after the node recovers)
 * are never touched by this call.
 */
export function claimInterruptedRuns(db: Db, nodeId: string, at: string): RunRow[] {
  return db.transaction(() => {
    const rows = db
      .prepare(`SELECT * FROM runs WHERE status = 'running' AND node_id = ?`)
      .all(nodeId) as RunRow[];
    const mark = db.prepare(
      `UPDATE runs SET status = 'interrupted', finished_at = ?, interrupted_reason = 'node_offline'
       WHERE run_id = ? AND status = 'running'`,
    );
    return rows.filter((r) => mark.run(at, r.run_id).changes === 1);
  })();
}

export interface OrphanReport {
  /** Ingress runs closed as failed: Paperclip saw the dropped connection and retries. */
  failedIngress: string[];
  /** Replacements never sent: re-dispatched with no risk of running twice. */
  neverDispatched: string[];
  /** Replacements whose outcome is unknown: re-dispatched with the same Idempotency-Key. */
  outcomeUnknown: string[];
}

/**
 * Close out runs left `running` by a previous process. Only safe at startup,
 * before this process accepts requests (no run can be live yet).
 *
 * - Ingress runs: the Paperclip request that waited on them died with the old
 *   process, so Paperclip already saw a failure and retries on its next
 *   heartbeat. Re-dispatching here would run the task twice; mark them failed.
 * - Replacement runs: nobody else will retry them. Mark them interrupted and
 *   unrecovered, so recovery re-decides and re-sends them (at-least-once).
 */
export function reconcileOrphanedRuns(db: Db, at: string): OrphanReport {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM runs WHERE status = 'running'`).all() as RunRow[];
    const report: OrphanReport = { failedIngress: [], neverDispatched: [], outcomeUnknown: [] };
    const fail = db.prepare(
      `UPDATE runs SET status = 'failed', finished_at = ? WHERE run_id = ? AND status = 'running'`,
    );
    const interrupt = db.prepare(
      `UPDATE runs SET status = 'interrupted', finished_at = ?, recovered_at = NULL,
         interrupted_reason = 'dispatcher_restart'
       WHERE run_id = ? AND status = 'running'`,
    );
    for (const row of rows) {
      if (row.origin === "ingress") {
        fail.run(at, row.run_id);
        report.failedIngress.push(row.run_id);
      } else {
        interrupt.run(at, row.run_id);
        (row.dispatched_at ? report.outcomeUnknown : report.neverDispatched).push(row.run_id);
      }
    }
    return report;
  })();
}

/** Interrupted runs whose recovery has not been durably recorded (oldest first). */
export function listUnrecoveredRuns(db: Db): RunRow[] {
  return db
    .prepare(
      `SELECT * FROM runs WHERE status = 'interrupted' AND recovered_at IS NULL
       ORDER BY finished_at ASC, started_at ASC`,
    )
    .all() as RunRow[];
}

/** Record that an interrupted run's recovery has been written. */
export function markRecovered(db: Db, runId: string, at: string): void {
  db.prepare(`UPDATE runs SET recovered_at = ? WHERE run_id = ? AND recovered_at IS NULL`).run(
    at,
    runId,
  );
}

export function listRecentDecisions(db: Db, limit = 50): unknown[] {
  return db.prepare(`SELECT * FROM decisions ORDER BY id DESC LIMIT ?`).all(limit);
}

export function listInFlightRuns(db: Db): RunRow[] {
  return db.prepare(`SELECT * FROM runs WHERE status = 'running'`).all() as RunRow[];
}
