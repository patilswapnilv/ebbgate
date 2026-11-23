import { randomUUID } from "node:crypto";
import type { EbbgateConfig, Tier } from "@ebbgate/core";
import type { Db } from "../db/index.js";
import type { Logger } from "../logger.js";
import type { PaperclipClient } from "../paperclip/types.js";
import type { Notifier } from "./notifier.js";

/**
 * Lifecycle of a deferred task:
 *
 *   pending --claim--> waking --wake ok--> done
 *      ^                  |
 *      |   wake failed /  |  attempts >= maxAttempts
 *      +--- lease expired +----------------------------> dead
 *   pending --past its TTL--> expired
 *
 * `done`, `expired` and `dead` are terminal and always carry `terminal_reason`.
 * No state transition ever routes the task anywhere: draining only asks
 * Paperclip to wake the agent, and the resulting run is decided afresh by the
 * policy engine. So a private task can wait, expire or be dead-lettered, but it
 * never falls back to the cloud.
 */
export type DeferredStatus = "pending" | "waking" | "done" | "expired" | "dead";
export type TerminalStatus = Extract<DeferredStatus, "done" | "expired" | "dead">;

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
  wake_idempotency_key: string;
  claimed_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  expires_at: string | null;
  terminal_reason: string | null;
  finished_at: string | null;
}

/** How long a `waking` claim is held before it is considered abandoned (crash, restart). */
export const WAKE_CLAIM_LEASE_MS = 5 * 60 * 1000;

export interface QueuePolicy {
  /** Wake attempts before a task is dead-lettered. */
  maxAttempts: number;
  /** First retry delay; doubles per attempt. */
  retryBaseMs: number;
  /** Upper bound for the retry delay. */
  retryMaxMs: number;
  /** A claim older than this is reclaimable. */
  leaseMs: number;
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  maxAttempts: 10,
  retryBaseMs: 5_000,
  retryMaxMs: 15 * 60 * 1000,
  leaseMs: WAKE_CLAIM_LEASE_MS,
};

export function queuePolicyFrom(config: Pick<EbbgateConfig, "queue">): QueuePolicy {
  return {
    maxAttempts: config.queue.maxAttempts,
    retryBaseMs: config.queue.retryBaseSeconds * 1000,
    retryMaxMs: config.queue.retryMaxSeconds * 1000,
    leaseMs: config.queue.leaseSeconds * 1000,
  };
}

/** Delay before the next attempt after `attempts` failed ones (deterministic, no jitter). */
export function backoffMs(attempts: number, policy: QueuePolicy = DEFAULT_QUEUE_POLICY): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** Math.min(exp, 30));
}

/** A unique id for one dispatcher instance; it owns the claims it takes. */
export function newLeaseOwner(): string {
  return `ebbgate-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** One idempotency key per deferral, persisted with the row and reused on every retry. */
export function wakeKeyFor(runId: string): string {
  return `ebbgate-defer-${runId}`;
}

/** Expiry instant for a deferred task with an optional per-task TTL. */
export function expiryFor(createdAt: string, ttlHours: number | undefined): string | undefined {
  if (ttlHours === undefined) return undefined;
  return new Date(new Date(createdAt).getTime() + ttlHours * 3600 * 1000).toISOString();
}

export interface PersistResult {
  /** False when a row for this run already existed (a re-submit): nothing was written. */
  created: boolean;
  row: DeferredRow;
}

/**
 * Persist a deferred task before responding to Paperclip (invariant 3).
 * Idempotent: a re-submit of the same run is deduplicated on `run_id` (and its
 * idempotency key) and returns the existing row untouched.
 */
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
    /** Optional per-task TTL (ISO instant). Defaults to created_at + deferredMaxAgeHours. */
    expiresAt?: string;
  },
): PersistResult {
  const changes = db
    .prepare(
      `INSERT INTO deferred (run_id, issue_id, agent_id, company_id, tier, reason, payload_json,
         created_at, status, wake_idempotency_key, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      args.runId,
      args.issueId ?? null,
      args.agentId,
      args.companyId,
      args.tier,
      args.reason,
      JSON.stringify(args.payload),
      args.createdAt,
      wakeKeyFor(args.runId),
      args.expiresAt ?? null,
    ).changes;
  const row = getDeferredByRunId(db, args.runId);
  if (!row) throw new Error(`deferred row for ${args.runId} missing after insert`);
  return { created: changes === 1, row };
}

export function getDeferredByRunId(db: Db, runId: string): DeferredRow | undefined {
  return db.prepare(`SELECT * FROM deferred WHERE run_id = ?`).get(runId) as
    | DeferredRow
    | undefined;
}

export function countPendingDeferred(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM deferred WHERE status = 'pending'`).get() as {
    n: number;
  };
  return row.n;
}

/** Row counts per status (every status present, zero when empty). */
export function countDeferredByStatus(db: Db): Record<DeferredStatus, number> {
  const counts: Record<DeferredStatus, number> = {
    pending: 0,
    waking: 0,
    done: 0,
    expired: 0,
    dead: 0,
  };
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM deferred GROUP BY status`).all() as {
    status: DeferredStatus;
    n: number;
  }[];
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export function listPendingDeferred(db: Db): DeferredRow[] {
  return db
    .prepare(`SELECT * FROM deferred WHERE status = 'pending' ORDER BY created_at ASC, id ASC`)
    .all() as DeferredRow[];
}

/** Dead-lettered tasks, newest first, with their recorded reason. */
export function listDeadLetters(db: Db, limit = 50): DeferredRow[] {
  return db
    .prepare(
      `SELECT * FROM deferred WHERE status = 'dead' ORDER BY finished_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as DeferredRow[];
}

function leaseExpiry(at: Date, leaseMs: number): string {
  return new Date(at.getTime() + leaseMs).toISOString();
}

/**
 * Return claims to `pending` (or dead-letter them when their attempts are used
 * up). `where` selects which `waking` rows; it is ANDed with `status = 'waking'`.
 * Runs in one IMMEDIATE transaction.
 */
function releaseClaimsWhere(
  db: Db,
  where: string,
  params: unknown[],
  at: Date,
  maxAttempts: number,
  why: string,
): { released: number; dead: number } {
  return db
    .transaction(() => {
      const iso = at.toISOString();
      const dead = db
        .prepare(
          `UPDATE deferred SET status = 'dead', finished_at = ?,
             terminal_reason = ? || ' after ' || attempts || ' attempt(s); wake never confirmed',
             lease_owner = NULL, lease_expires_at = NULL, claimed_at = NULL
           WHERE status = 'waking' AND attempts >= ? AND (${where})`,
        )
        .run(iso, why, maxAttempts, ...params).changes;
      const released = db
        .prepare(
          `UPDATE deferred SET status = 'pending', claimed_at = NULL, lease_owner = NULL,
             lease_expires_at = NULL, next_attempt_at = NULL,
             last_error = COALESCE(last_error, ?)
           WHERE status = 'waking' AND (${where})`,
        )
        .run(why, ...params).changes;
      return { released, dead };
    })
    .immediate();
}

/**
 * Reclaim `waking` claims whose lease has run out (the holder crashed, hung or
 * restarted). Rows from before migration 005 have no `lease_expires_at`; their
 * lease is measured from `claimed_at`. Returns how many went back to `pending`.
 */
export function releaseStaleClaims(
  db: Db,
  now: Date,
  leaseMs = WAKE_CLAIM_LEASE_MS,
  maxAttempts = DEFAULT_QUEUE_POLICY.maxAttempts,
): number {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - leaseMs).toISOString();
  return releaseClaimsWhere(
    db,
    `(lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       OR (lease_expires_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?))`,
    [nowIso, cutoff],
    now,
    maxAttempts,
    "lease expired",
  ).released;
}

/**
 * Startup: reclaim every claim not held by `owner`. Ebbgate runs one dispatcher
 * per database file, so at startup any other holder is a previous, dead process;
 * waiting out its lease would only delay the wake. Re-sending is safe because the
 * wake reuses the row's idempotency key.
 */
export function reclaimAbandonedClaims(
  db: Db,
  owner: string,
  now: Date,
  maxAttempts = DEFAULT_QUEUE_POLICY.maxAttempts,
): { released: number; dead: number } {
  return releaseClaimsWhere(
    db,
    `lease_owner IS NULL OR lease_owner <> ?`,
    [owner],
    now,
    maxAttempts,
    "claim abandoned by a previous dispatcher process",
  );
}

/** Graceful shutdown: hand this instance's claims back so the next process retries them at once. */
export function releaseOwnClaims(db: Db, owner: string): number {
  return db
    .prepare(
      `UPDATE deferred SET status = 'pending', claimed_at = NULL, lease_owner = NULL,
         lease_expires_at = NULL, next_attempt_at = NULL
       WHERE status = 'waking' AND lease_owner = ?`,
    )
    .run(owner).changes;
}

/** Move a row from `pending` to a terminal status with a reason. False if someone got there first. */
function finishPending(
  db: Db,
  id: number,
  status: TerminalStatus,
  reason: string,
  at: Date,
): boolean {
  return (
    db
      .prepare(
        `UPDATE deferred SET status = ?, terminal_reason = ?, finished_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, reason, at.toISOString(), id).changes === 1
  );
}

/** Claim a due `pending` row for a wake, counting the attempt. */
function claim(db: Db, id: number, owner: string, at: Date, leaseMs: number): boolean {
  const iso = at.toISOString();
  return (
    db
      .prepare(
        `UPDATE deferred SET status = 'waking', claimed_at = ?, lease_owner = ?,
           lease_expires_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      )
      .run(iso, owner, leaseExpiry(at, leaseMs), id, iso).changes === 1
  );
}

function expiryMs(row: DeferredRow, maxAgeMs: number): number {
  return row.expires_at
    ? new Date(row.expires_at).getTime()
    : new Date(row.created_at).getTime() + maxAgeMs;
}

function isDue(row: DeferredRow, at: Date): boolean {
  return row.next_attempt_at === null || new Date(row.next_attempt_at).getTime() <= at.getTime();
}

export interface DrainResult {
  woken: number;
  failed: number;
  expired: number;
  /** Rows dead-lettered by this drain (attempts used up). */
  dead: number;
}

/**
 * Drain the deferred queue: expire old items, then wake agents (oldest first),
 * one wake per issue, with at most `drainConcurrency` wakes in flight.
 *
 * - Every row is claimed with a conditional update (`pending` -> `waking`)
 *   before its wake is sent, so overlapping drains (in this process or another
 *   one sharing the file) can never wake a row twice. The claim is a lease owned
 *   by `owner`; if the holder dies, the lease runs out and the row is reclaimed.
 * - Each claim counts an attempt. A failed wake goes back to `pending` with
 *   exponential backoff (`next_attempt_at`); after `maxAttempts` it is `dead`,
 *   with the last error recorded as its reason.
 * - Other pending rows for the same issue stay `pending` until the covering
 *   wake succeeds; only then are they closed. If it fails, they remain retryable.
 * - Every retry reuses the row's persisted idempotency key.
 * - When `stopping()` turns true (graceful shutdown), no new claims are taken.
 */
export async function drainDeferred(args: {
  db: Db;
  paperclip: PaperclipClient;
  notifier: Notifier;
  logger: Logger;
  clock: () => Date;
  deferredMaxAgeHours: number;
  drainConcurrency: number;
  policy?: Partial<QueuePolicy>;
  owner?: string;
  stopping?: () => boolean;
}): Promise<DrainResult> {
  const { db, paperclip, notifier, logger, clock, deferredMaxAgeHours, drainConcurrency } = args;
  const policy: QueuePolicy = { ...DEFAULT_QUEUE_POLICY, ...args.policy };
  const owner = args.owner ?? newLeaseOwner();
  const stopping = args.stopping ?? (() => false);
  const result: DrainResult = { woken: 0, failed: 0, expired: 0, dead: 0 };
  const startedAt = clock();
  releaseStaleClaims(db, startedAt, policy.leaseMs, policy.maxAttempts);

  const maxAgeMs = deferredMaxAgeHours * 3600 * 1000;
  const expire = async (row: DeferredRow, at: Date): Promise<void> => {
    const ttl = row.expires_at
      ? `its TTL (${row.expires_at})`
      : `the ${deferredMaxAgeHours}h queue limit`;
    const reason = `expired: still waiting for a local node after ${ttl}; not re-routed`;
    if (finishPending(db, row.id, "expired", reason, at)) {
      result.expired += 1;
      await notifier.notify("deferred_expired", null, `deferred run ${row.run_id} ${reason}`);
    }
  };

  const toWake: DeferredRow[] = [];
  /** Pending rows covered by the wake of a primary row, keyed by the primary's id. */
  const coveredBy = new Map<number, number[]>();
  const primaryForIssue = new Map<string, number>();

  for (const row of listPendingDeferred(db)) {
    if (startedAt.getTime() > expiryMs(row, maxAgeMs)) {
      await expire(row, startedAt);
      continue;
    }
    if (!isDue(row, startedAt)) continue; // backing off after a failed wake

    const issueKey = row.issue_id ?? `run:${row.run_id}`;
    const primary = primaryForIssue.get(issueKey);
    if (primary !== undefined) {
      coveredBy.get(primary)?.push(row.id);
      continue;
    }
    primaryForIssue.set(issueKey, row.id);
    coveredBy.set(row.id, []);
    toWake.push(row);
  }

  const succeed = db.transaction((row: DeferredRow, at: string) => {
    db.prepare(
      `UPDATE deferred SET status = 'done', terminal_reason = 'woken', finished_at = ?,
         lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE id = ? AND status IN ('waking', 'pending')`,
    ).run(at, row.id);
    const closeCovered = db.prepare(
      `UPDATE deferred SET status = 'done', terminal_reason = ?, finished_at = ?
       WHERE id = ? AND status = 'pending'`,
    );
    for (const id of coveredBy.get(row.id) ?? []) {
      closeCovered.run(`covered by the wake of ${row.run_id} (same issue)`, at, id);
    }
  });

  /** Back off or dead-letter a failed wake. Only touches the row if we still hold its claim. */
  const fail = db.transaction(
    (row: DeferredRow, at: Date, error: string): "retry" | "dead" | null => {
      const current = db
        .prepare(
          `SELECT attempts FROM deferred WHERE id = ? AND status = 'waking' AND lease_owner = ?`,
        )
        .get(row.id, owner) as { attempts: number } | undefined;
      if (!current) return null; // lease lost; whoever holds the row now owns its outcome
      if (current.attempts >= policy.maxAttempts) {
        db.prepare(
          `UPDATE deferred SET status = 'dead', finished_at = ?, last_error = ?,
           terminal_reason = ?, lease_owner = NULL, lease_expires_at = NULL, claimed_at = NULL
         WHERE id = ?`,
        ).run(
          at.toISOString(),
          error,
          `wake failed ${current.attempts} time(s); last error: ${error}`,
          row.id,
        );
        return "dead";
      }
      db.prepare(
        `UPDATE deferred SET status = 'pending', claimed_at = NULL, lease_owner = NULL,
         lease_expires_at = NULL, last_error = ?, next_attempt_at = ?
       WHERE id = ?`,
      ).run(
        error,
        new Date(at.getTime() + backoffMs(current.attempts, policy)).toISOString(),
        row.id,
      );
      return "retry";
    },
  );

  for (let i = 0; i < toWake.length; i += drainConcurrency) {
    if (stopping()) break;
    const batch = toWake.slice(i, i + drainConcurrency);
    await Promise.all(
      batch.map(async (row) => {
        // Re-check age at claim time: earlier wakes in this drain may have taken long
        // enough for this row to cross the limit since the scan.
        const claimAt = clock();
        if (claimAt.getTime() > expiryMs(row, maxAgeMs)) {
          await expire(row, claimAt);
          return; // covered rows stay pending and get their own chance
        }
        if (!claim(db, row.id, owner, claimAt, policy.leaseMs)) return;
        try {
          await paperclip.wakeAgent({
            agentId: row.agent_id,
            ...(row.issue_id ? { issueId: row.issue_id } : {}),
            reason: "ebbgate: local node available; draining deferred queue",
            idempotencyKey: row.wake_idempotency_key,
          });
          succeed(row, clock().toISOString());
          result.woken += 1;
        } catch (err) {
          result.failed += 1;
          const error = String(err).slice(0, 500);
          const outcome = fail.immediate(row, clock(), error);
          if (outcome === "dead") {
            result.dead += 1;
            logger.error({ err: error, runId: row.run_id }, "wakeAgent failed; dead-lettered");
            await notifier.notify(
              "deferred_dead",
              null,
              `deferred run ${row.run_id} dead-lettered after ${policy.maxAttempts} attempt(s): ${error}`,
            );
          } else {
            logger.warn({ err: error, runId: row.run_id }, "wakeAgent failed; will retry");
          }
        }
      }),
    );
  }

  if (result.woken > 0) {
    await notifier.notify("queue_drained", null, `woke ${result.woken} deferred issue(s)`);
  }
  return result;
}
