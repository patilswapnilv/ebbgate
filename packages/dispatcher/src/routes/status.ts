import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { bearerMatches } from "../auth.js";
import {
  type AuditKind,
  baseTaskId,
  heldByReason,
  listAudit,
  listWaiting,
  MAX_AUDIT_LIMIT,
  presenceSummary,
  queueCounts,
} from "../services/audit.js";
import { countPendingDeferred } from "../services/queue.js";
import { listInFlightRuns, listRecentDecisions } from "../services/runs.js";

/** How many waiting tasks `/status` lists (counts always cover all of them). */
export const STATUS_WAITING_LIMIT = 100;
const GROUPING_SCAN_LIMIT = 10_000;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export function statusRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/status", (c) => {
    // v0.1: admin token = paperclip.sharedSecret (no separate admin secret in config).
    if (!bearerMatches(c.req.header("authorization"), c.get("config").paperclip.sharedSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const presence = c.get("presence");
    const db = c.get("db");
    const nodes = presence.listNodeStatuses();
    const waiting = listWaiting(db, GROUPING_SCAN_LIMIT);
    const byReason = heldByReason(waiting);
    return c.json({
      generatedAt: c.get("now")().toISOString(),
      presence: presenceSummary(nodes),
      queue: queueCounts(db),
      waiting: waiting.slice(0, STATUS_WAITING_LIMIT),
      heldByReason: byReason,
      topReason: byReason[0] ?? null,
      // v0.1 fields, kept for existing clients.
      nodes,
      queueDepth: countPendingDeferred(db),
      // Payloads never leave the dispatcher through /status.
      inFlight: listInFlightRuns(db).map(({ payload_json: _payload, ...run }) => run),
      recentDecisions: listRecentDecisions(db, 20),
    });
  });

  /**
   * GET /decisions?taskId=&agentId=&kind=route|admission&limit=
   * The audit log, newest first. No payloads, no secrets.
   */
  app.get("/decisions", (c) => {
    if (!bearerMatches(c.req.header("authorization"), c.get("config").paperclip.sharedSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const taskId = c.req.query("taskId");
    const agentId = c.req.query("agentId");
    const kind = c.req.query("kind");
    const limitRaw = c.req.query("limit");
    if (taskId !== undefined && !ID.test(taskId)) return c.json({ error: "invalid taskId" }, 400);
    if (agentId !== undefined && !ID.test(agentId))
      return c.json({ error: "invalid agentId" }, 400);
    if (kind !== undefined && kind !== "route" && kind !== "admission")
      return c.json({ error: 'kind must be "route" or "admission"' }, 400);
    let limit = 50;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT)
        return c.json({ error: `limit must be 1..${MAX_AUDIT_LIMIT}` }, 400);
    }
    const db = c.get("db");
    const decisions = listAudit(db, {
      ...(taskId ? { taskId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(kind ? { kind: kind as AuditKind } : {}),
      limit,
    });
    const waiting = taskId
      ? (listWaiting(db, GROUPING_SCAN_LIMIT).find(
          (w) => baseTaskId(w.taskId) === baseTaskId(taskId),
        ) ?? null)
      : undefined;
    return c.json({ decisions, ...(waiting !== undefined ? { waiting } : {}) });
  });

  return app;
}
