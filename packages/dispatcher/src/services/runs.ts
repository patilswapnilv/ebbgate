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
}

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
  },
): void {
  db.prepare(
    `INSERT INTO runs (run_id, issue_id, agent_id, company_id, target, node_id, priority, status, started_at, finished_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, ?)`,
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
      `UPDATE runs SET status = 'interrupted', finished_at = ? WHERE run_id = ? AND status = 'running'`,
    );
    return rows.filter((r) => mark.run(at, r.run_id).changes === 1);
  })();
}

export function listRecentDecisions(db: Db, limit = 50): unknown[] {
  return db.prepare(`SELECT * FROM decisions ORDER BY id DESC LIMIT ?`).all(limit);
}

export function listInFlightRuns(db: Db): RunRow[] {
  return db.prepare(`SELECT * FROM runs WHERE status = 'running'`).all() as RunRow[];
}
