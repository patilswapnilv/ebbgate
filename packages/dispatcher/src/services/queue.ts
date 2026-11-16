import type { Tier } from "@ebbgate/core";
import type { Db } from "../db/index.js";
import type { Logger } from "../logger.js";
import type { PaperclipClient } from "../paperclip/types.js";
import type { Notifier } from "./notifier.js";

export type DeferredStatus = "pending" | "waking" | "done" | "expired";

export interface DeferredRow {
  id: number;
  run_id: string;
  issue_id: string | null;
  agent_id: string;
  company_id: string;
  tier: string;
  reason: string;
  payload_json: string;
  created_at: string;
  status: DeferredStatus;
  wake_idempotency_key: string | null;
  claimed_at: string | null;
}

/** How long a `waking` claim is held before it is considered abandoned (crash, restart). */
export const WAKE_CLAIM_LEASE_MS = 5 * 60 * 1000;

/** One idempotency key per deferral, persisted with the row and reused on every retry. */
export function wakeKeyFor(runId: string): string {
  return `ebbgate-defer-${runId}`;
}

/** Persist a deferred task before responding to Paperclip (invariant 3). */
export function persistDeferred(
  db: Db,
  args: {
    runId: string;
    issueId?: string;
    agentId: string;
    companyId: string;
    tier: Tier;
    reason: string;
    payload: unknown;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO deferred (run_id, issue_id, agent_id, company_id, tier, reason, payload_json, created_at, status, wake_idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    args.runId,
    args.issueId ?? null,
    args.agentId,
    args.companyId,
    args.tier,
    args.reason,
    JSON.stringify(args.payload),
    args.createdAt,
    wakeKeyFor(args.runId),
  );
}

export function countPendingDeferred(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM deferred WHERE status = 'pending'`).get() as {
    n: number;
  };
  return row.n;
}

export function listPendingDeferred(db: Db): DeferredRow[] {
  return db
    .prepare(`SELECT * FROM deferred WHERE status = 'pending' ORDER BY created_at ASC, id ASC`)
    .all() as DeferredRow[];
}

/** Return abandoned `waking` claims (older than the lease) to `pending`. */
export function releaseStaleClaims(db: Db, now: Date, leaseMs = WAKE_CLAIM_LEASE_MS): number {
  const cutoff = new Date(now.getTime() - leaseMs).toISOString();
  return db
    .prepare(
      `UPDATE deferred SET status = 'pending', claimed_at = NULL
       WHERE status = 'waking' AND (claimed_at IS NULL OR claimed_at < ?)`,
    )
    .run(cutoff).changes;
}

/** Move a row from `pending` to `status`. Returns false if someone else got there first. */
function transitionPending(
  db: Db,
  id: number,
  status: Exclude<DeferredStatus, "pending">,
  claimedAt: string | null = null,
): boolean {
  return (
    db
      .prepare(`UPDATE deferred SET status = ?, claimed_at = ? WHERE id = ? AND status = 'pending'`)
      .run(status, claimedAt, id).changes === 1
  );
}

export interface DrainResult {
  woken: number;
  failed: number;
  expired: number;
}

/**
 * Drain the deferred queue: expire old items, then wake agents (oldest first),
 * deduped per issueId, with at most `drainConcurrency` wakes in flight.
 *
 * Every row is claimed with a conditional update (`pending` -> `waking`) before
 * its wake is sent, so overlapping drains can never wake the same row twice.
 * Claims carry a timestamp and expire after WAKE_CLAIM_LEASE_MS; each retry
 * reuses the row's persisted idempotency key, so Paperclip can deduplicate a
 * wake whose outcome was unknown.
 */
export async function drainDeferred(args: {
  db: Db;
  paperclip: PaperclipClient;
  notifier: Notifier;
  logger: Logger;
  now: Date;
  deferredMaxAgeHours: number;
  drainConcurrency: number;
}): Promise<DrainResult> {
  const { db, paperclip, notifier, logger, now, deferredMaxAgeHours, drainConcurrency } = args;
  const result: DrainResult = { woken: 0, failed: 0, expired: 0 };
  releaseStaleClaims(db, now);

  const maxAgeMs = deferredMaxAgeHours * 3600 * 1000;
  const toWake: DeferredRow[] = [];
  const seenIssues = new Set<string>();

  for (const row of listPendingDeferred(db)) {
    const age = now.getTime() - new Date(row.created_at).getTime();
    if (age > maxAgeMs) {
      if (transitionPending(db, row.id, "expired")) {
        result.expired += 1;
        await notifier.notify(
          "deferred_expired",
          null,
          `deferred run ${row.run_id} expired after ${deferredMaxAgeHours}h`,
        );
      }
      continue;
    }

    const issueKey = row.issue_id ?? `run:${row.run_id}`;
    if (seenIssues.has(issueKey)) {
      // Dedupe per issue: one wake covers every deferral of the same issue.
      transitionPending(db, row.id, "done");
      continue;
    }
    seenIssues.add(issueKey);
    toWake.push(row);
  }

  for (let i = 0; i < toWake.length; i += drainConcurrency) {
    const batch = toWake.slice(i, i + drainConcurrency);
    await Promise.all(
      batch.map(async (row) => {
        if (!transitionPending(db, row.id, "waking", now.toISOString())) return; // claimed elsewhere
        try {
          await paperclip.wakeAgent({
            agentId: row.agent_id,
            ...(row.issue_id ? { issueId: row.issue_id } : {}),
            reason: "ebbgate: local node available; draining deferred queue",
            idempotencyKey: row.wake_idempotency_key ?? wakeKeyFor(row.run_id),
          });
          db.prepare(`UPDATE deferred SET status = 'done' WHERE id = ? AND status = 'waking'`).run(
            row.id,
          );
          result.woken += 1;
        } catch (err) {
          result.failed += 1;
          logger.warn({ err: String(err), runId: row.run_id }, "wakeAgent failed; will retry");
          db.prepare(
            `UPDATE deferred SET status = 'pending', claimed_at = NULL WHERE id = ? AND status = 'waking'`,
          ).run(row.id);
        }
      }),
    );
  }

  if (result.woken > 0) {
    await notifier.notify("queue_drained", null, `woke ${result.woken} deferred issue(s)`);
  }
  return result;
}
