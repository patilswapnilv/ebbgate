import {
  type AdmissionResult,
  AUDIT_DEFAULTS,
  type Decision,
  type DecisionReason,
  type EbbgateConfig,
  isReasonCode,
  type NodeStatus,
  overallState,
  type PresenceState,
  REASON_CODES,
  type ReasonCode,
  type Tier,
} from "@ebbgate/core";
import type { Db } from "../db/index.js";

/**
 * Append-only audit log of routing and admission decisions (`decision_audit`).
 *
 * Stores ids, codes and presence states only: never payloads, prompts or secrets.
 * Rows are never updated (a trigger enforces it); retention deletes the oldest.
 */

export type AuditKind = "route" | "admission";
export type AuditDecision = "local" | "cloud" | "defer" | "admit" | "refuse";

export interface AuditRow {
  id: number;
  kind: AuditKind;
  task_id: string | null;
  agent_id: string | null;
  issue_id: string | null;
  environment_id: string | null;
  decision: AuditDecision;
  target: string | null;
  tier: Tier;
  reason_code: string;
  reason_text: string;
  rule_ref: string;
  presence: PresenceState;
  decided_at: string;
}

/** The public (JSON) shape of an audit entry. */
export interface AuditEntry {
  id: number;
  kind: AuditKind;
  taskId: string | null;
  agentId: string | null;
  issueId: string | null;
  environmentId: string | null;
  decision: AuditDecision;
  target: string | null;
  tier: Tier;
  code: string;
  text: string;
  rule: string;
  presence: PresenceState;
  decidedAt: string;
}

export function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    kind: r.kind,
    taskId: r.task_id,
    agentId: r.agent_id,
    issueId: r.issue_id,
    environmentId: r.environment_id,
    decision: r.decision,
    target: r.target,
    tier: r.tier,
    code: r.reason_code,
    text: r.reason_text,
    rule: r.rule_ref,
    presence: r.presence,
    decidedAt: r.decided_at,
  };
}

function insert(
  db: Db,
  row: Omit<AuditRow, "id" | "reason_code" | "reason_text" | "rule_ref" | "presence" | "tier"> & {
    why: DecisionReason;
  },
): void {
  db.prepare(
    `INSERT INTO decision_audit
       (kind, task_id, agent_id, issue_id, environment_id, decision, target, tier,
        reason_code, reason_text, rule_ref, presence, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.kind,
    row.task_id,
    row.agent_id,
    row.issue_id,
    row.environment_id,
    row.decision,
    row.target,
    row.why.tier,
    row.why.code,
    row.why.text,
    String(row.why.rule),
    row.why.presence,
    row.decided_at,
  );
}

/** Record a routing decision (POST /run or a recovery re-decision). */
export function auditRoute(
  db: Db,
  args: { runId: string; agentId: string; issueId?: string; decision: Decision; decidedAt: string },
): void {
  const d = args.decision;
  insert(db, {
    kind: "route",
    task_id: args.runId,
    agent_id: args.agentId,
    issue_id: args.issueId ?? null,
    environment_id: null,
    decision: d.action,
    target: d.action === "local" ? d.node : d.action === "cloud" ? "cloud" : "queue",
    why: d.why,
    decided_at: args.decidedAt,
  });
}

/** Record an admission answer (POST /admit). Probes carry no run id. */
export function auditAdmission(
  db: Db,
  args: {
    agentId?: string;
    environmentId?: string;
    target: string;
    result: AdmissionResult;
    decidedAt: string;
  },
): void {
  insert(db, {
    kind: "admission",
    task_id: null,
    agent_id: args.agentId ?? null,
    issue_id: null,
    environment_id: args.environmentId ?? null,
    decision: args.result.admit ? "admit" : "refuse",
    target: args.target,
    why: args.result.why,
    decided_at: args.decidedAt,
  });
}

/** Suffixes the dispatcher appends to a run id (re-deferral, replacement runs). */
const DERIVED_SUFFIX = /:(redecide|local|cloud)$/;

/** The Paperclip run id a derived id (`<run>:redecide`, `<run>:local`) belongs to. */
export function baseTaskId(taskId: string): string {
  return taskId.replace(DERIVED_SUFFIX, "");
}

export interface AuditQuery {
  taskId?: string;
  agentId?: string;
  kind?: AuditKind;
  limit?: number;
}

export const MAX_AUDIT_LIMIT = 500;

/** Newest first. A task id matches its derived ids too. */
export function listAudit(db: Db, q: AuditQuery = {}): AuditEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.taskId) {
    where.push("task_id = ?");
    params.push(baseTaskId(q.taskId));
  }
  if (q.agentId) {
    where.push("agent_id = ?");
    params.push(q.agentId);
  }
  if (q.kind) {
    where.push("kind = ?");
    params.push(q.kind);
  }
  const limit = Math.min(Math.max(1, q.limit ?? 50), MAX_AUDIT_LIMIT);
  const sql = `SELECT * FROM decision_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC LIMIT ?`;
  return (db.prepare(sql).all(...params, limit) as AuditRow[]).map(toEntry);
}

export interface PruneResult {
  byAge: number;
  byCount: number;
}

/** Apply retention: drop rows older than `retentionDays`, then cap at `maxRows`. */
export function pruneAudit(
  db: Db,
  now: Date,
  opts: { retentionDays?: number; maxRows?: number } = {},
): PruneResult {
  const retentionDays = opts.retentionDays ?? AUDIT_DEFAULTS.retentionDays;
  const maxRows = opts.maxRows ?? AUDIT_DEFAULTS.maxRows;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return db.transaction(() => {
    const byAge = db.prepare(`DELETE FROM decision_audit WHERE decided_at < ?`).run(cutoff).changes;
    const byCount = db
      .prepare(
        `DELETE FROM decision_audit WHERE id <= (
           SELECT id FROM decision_audit ORDER BY id DESC LIMIT 1 OFFSET ?
         )`,
      )
      .run(maxRows).changes;
    return { byAge, byCount };
  })();
}

export function auditRetention(config: Pick<EbbgateConfig, "audit">): {
  retentionDays: number;
  maxRows: number;
} {
  return {
    retentionDays: config.audit?.retentionDays ?? AUDIT_DEFAULTS.retentionDays,
    maxRows: config.audit?.maxRows ?? AUDIT_DEFAULTS.maxRows,
  };
}

/* ------------------------------------------------------------------ status */

export interface QueueCounts {
  pending: number;
  waking: number;
  done: number;
  expired: number;
  /** Tasks still held at the gate: pending + waking. */
  held: number;
}

/** Read-only counts of the defer queue by status. */
export function queueCounts(db: Db): QueueCounts {
  const counts: QueueCounts = { pending: 0, waking: 0, done: 0, expired: 0, held: 0 };
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM deferred GROUP BY status`).all() as {
    status: string;
    n: number;
  }[];
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof QueueCounts] = r.n;
  }
  counts.held = counts.pending + counts.waking;
  return counts;
}

export interface WaitingTask {
  taskId: string;
  agentId: string;
  issueId: string | null;
  tier: string;
  status: "pending" | "waking";
  since: string;
  code: string;
  text: string;
  rule: string | null;
  /** Presence when the task was held. */
  presenceAtDecision: string | null;
}

/**
 * Every task waiting at the gate, oldest first, with why it is waiting. The
 * reason comes from the latest routing audit entry for the task; tasks deferred
 * before the audit log existed fall back to the stored reason text.
 */
export function listWaiting(db: Db, limit = 100): WaitingTask[] {
  const rows = db
    .prepare(
      `SELECT run_id, agent_id, issue_id, tier, status, created_at, reason FROM deferred
       WHERE status IN ('pending', 'waking') ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as {
    run_id: string;
    agent_id: string;
    issue_id: string | null;
    tier: string;
    status: "pending" | "waking";
    created_at: string;
    reason: string;
  }[];
  const latest = db.prepare(
    `SELECT * FROM decision_audit WHERE kind = 'route' AND task_id = ? AND decision = 'defer'
     ORDER BY id DESC LIMIT 1`,
  );
  return rows.map((r) => {
    const a = latest.get(baseTaskId(r.run_id)) as AuditRow | undefined;
    return {
      taskId: r.run_id,
      agentId: r.agent_id,
      issueId: r.issue_id,
      tier: r.tier,
      status: r.status,
      since: r.created_at,
      code: a?.reason_code ?? "HELD_UNKNOWN",
      text: a?.reason_text ?? `held: ${r.reason}`,
      rule: a?.rule_ref ?? null,
      presenceAtDecision: a?.presence ?? null,
    };
  });
}

export interface ReasonCount {
  code: string;
  text: string;
  count: number;
}

/** Held tasks grouped by reason code, most common first. */
export function heldByReason(waiting: readonly WaitingTask[]): ReasonCount[] {
  const map = new Map<string, ReasonCount>();
  for (const w of waiting) {
    const text = isReasonCode(w.code) ? REASON_CODES[w.code as ReasonCode] : w.text;
    const cur = map.get(w.code) ?? { code: w.code, text, count: 0 };
    cur.count += 1;
    map.set(w.code, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export function presenceSummary(nodes: readonly NodeStatus[]): {
  overall: PresenceState;
  nodes: Array<{ node: string; state: PresenceState; lastSeenAt: string | null }>;
} {
  return {
    overall: overallState(nodes),
    nodes: nodes.map((n) => ({ node: n.node, state: n.state, lastSeenAt: n.lastSeenAt })),
  };
}
