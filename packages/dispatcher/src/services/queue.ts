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
  const wakeKey = args.issueId ? `ebbgate-defer-${args.issueId}` : null;
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
    wakeKey,
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

/**
 * Drain the deferred queue: expire old items, then wake agents (oldest first),
 * deduped per issueId, with concurrency limited by drainConcurrency.
 */
export async function drainDeferred(args: {
  db: Db;
  paperclip: PaperclipClient;
  notifier: Notifier;
  logger: Logger;
  now: Date;
  deferredMaxAgeHours: number;
  drainConcurrency: number;
}): Promise<void> {
  const { db, paperclip, notifier, logger, now, deferredMaxAgeHours, drainConcurrency } = args;
  const pending = listPendingDeferred(db);
  const maxAgeMs = deferredMaxAgeHours * 3600 * 1000;

  const toWake: DeferredRow[] = [];
  const seenIssues = new Set<string>();

  for (const row of pending) {
    const age = now.getTime() - new Date(row.created_at).getTime();
    if (age > maxAgeMs) {
      db.prepare(`UPDATE deferred SET status = 'expired' WHERE id = ?`).run(row.id);
      await notifier.notify(
        "deferred_expired",
        null,
        `deferred run ${row.run_id} expired after ${deferredMaxAgeHours}h`,
      );
      continue;
    }

    const issueKey = row.issue_id ?? `run:${row.run_id}`;
    if (seenIssues.has(issueKey)) {
      // Dedupe per issue: mark extras done without a second wake.
      db.prepare(`UPDATE deferred SET status = 'done' WHERE id = ?`).run(row.id);
      continue;
    }
    seenIssues.add(issueKey);
    toWake.push(row);
  }

  let drained = 0;
  for (let i = 0; i < toWake.length; i += drainConcurrency) {
    const batch = toWake.slice(i, i + drainConcurrency);
    await Promise.all(
      batch.map(async (row) => {
        db.prepare(`UPDATE deferred SET status = 'waking' WHERE id = ?`).run(row.id);
        try {
          await paperclip.wakeAgent({
            agentId: row.agent_id,
            ...(row.issue_id ? { issueId: row.issue_id } : {}),
            reason: "ebbgate: local node available; draining deferred queue",
          });
          db.prepare(`UPDATE deferred SET status = 'done' WHERE id = ?`).run(row.id);
          drained += 1;
        } catch (err) {
          logger.warn({ err: String(err), runId: row.run_id }, "wakeAgent failed; leaving pending");
          db.prepare(`UPDATE deferred SET status = 'pending' WHERE id = ?`).run(row.id);
        }
      }),
    );
  }

  if (drained > 0) {
    await notifier.notify("queue_drained", null, `woke ${drained} deferred issue(s)`);
  }
}
