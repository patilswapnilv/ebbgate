import { decide, resolveTier, type TaskContext } from "@ebbgate/core";
import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { bearerMatches } from "../auth.js";
import { ParseError } from "../paperclip/parse.js";
import { persistDeferred } from "../services/queue.js";
import { relayResponse } from "../services/relay.js";
import { forwardToRunner } from "../services/runner.js";
import { finishRun, insertRunning, recordDecision } from "../services/runs.js";

export function runRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/run", async (c) => {
    // TODO(verify-paperclip): HMAC signing of webhook bodies — docs currently only confirm bearer.
    if (!bearerMatches(c.req.header("authorization"), c.get("config").paperclip.sharedSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const paperclip = c.get("paperclip");
    const config = c.get("config");
    const db = c.get("db");
    const presence = c.get("presence");
    const logger = c.get("logger");
    const notifier = c.get("notifier");
    const now = c.get("now");
    const fetchFn = c.get("fetch");

    /**
     * Record the runner's outcome, unless interruption recovery already took the
     * run over (the update is conditional on the run still being `running`).
     */
    const settle = (runId: string, status: number): void => {
      const outcome = status >= 200 && status < 300 ? "completed" : "failed";
      if (!finishRun(db, runId, outcome, now().toISOString())) {
        logger.info({ runId, status }, "late runner response ignored; run was already re-decided");
      }
    };

    let input: ReturnType<typeof paperclip.parseRun>;
    try {
      input = paperclip.parseRun(body, c.req.raw.headers);
    } catch (err) {
      const message = err instanceof ParseError ? err.message : "invalid payload";
      return c.json({ error: message }, 400);
    }

    const tier = resolveTier(input.agentId, config);
    const task: TaskContext = {
      runId: input.runId,
      agentId: input.agentId,
      companyId: input.companyId,
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}),
      tier,
      labels: input.labels,
    };

    // Invariant: private / unknown never go to cloud (enforced again in decide()).
    const decision = decide(task, presence.listNodeStatuses(), config);
    const decidedAt = now().toISOString();
    recordDecision(db, {
      runId: task.runId,
      agentId: task.agentId,
      ...(task.issueId ? { issueId: task.issueId } : {}),
      tier,
      decision,
      decidedAt,
    });

    if (decision.action === "defer") {
      // Persist first, then notify Paperclip / notifier (invariant 3).
      persistDeferred(db, {
        runId: task.runId,
        ...(task.issueId ? { issueId: task.issueId } : {}),
        agentId: task.agentId,
        companyId: task.companyId,
        tier,
        reason: decision.reason,
        payload: body,
        createdAt: decidedAt,
      });

      if (task.issueId) {
        try {
          await paperclip.commentOnIssue(
            task.issueId,
            "Ebbgate: deferred until a local node is available (waiting-for-local).",
          );
          await paperclip.addLabel(task.issueId, "waiting-for-local");
        } catch (err) {
          logger.warn({ err: String(err) }, "paperclip defer annotations failed");
        }
      }

      if (decision.notify) {
        await notifier.notify("task_deferred", null, decision.reason);
      }

      // TODO(verify-paperclip): exact ack body; 2xx is required. Spec: success so Paperclip
      // does not count a failure. BYO docs use 202.
      return c.json({ status: "accepted", action: "defer", reason: decision.reason }, 202);
    }

    if (decision.action === "cloud") {
      if (tier === "private") {
        // Defense in depth — should be unreachable given decide() guard.
        logger.error({ runId: task.runId }, "refusing cloud dispatch for private tier");
        return c.json({ error: "private tasks never run in the cloud" }, 500);
      }
      insertRunning(db, {
        runId: task.runId,
        ...(task.issueId ? { issueId: task.issueId } : {}),
        agentId: task.agentId,
        companyId: task.companyId,
        target: "cloud",
        startedAt: decidedAt,
        payload: body,
      });
      try {
        const result = await forwardToRunner(config.cloud.runner, body, c.req.raw.headers, fetchFn);
        settle(task.runId, result.status);
        return relayResponse(result);
      } catch (err) {
        finishRun(db, task.runId, "failed", now().toISOString());
        logger.error({ err: String(err) }, "cloud forward failed");
        return c.json({ error: "cloud runner unreachable" }, 502);
      }
    }

    // local
    const nodeId = decision.node;
    const runnerUrl = config.nodes[nodeId]?.runner;
    if (!runnerUrl) {
      return c.json({ error: `no runner for node ${nodeId}` }, 500);
    }
    insertRunning(db, {
      runId: task.runId,
      ...(task.issueId ? { issueId: task.issueId } : {}),
      agentId: task.agentId,
      companyId: task.companyId,
      target: "local",
      nodeId,
      priority: decision.priority,
      startedAt: decidedAt,
      payload: body,
    });
    try {
      const result = await forwardToRunner(runnerUrl, body, c.req.raw.headers, fetchFn);
      settle(task.runId, result.status);
      return relayResponse(result);
    } catch (err) {
      if (!finishRun(db, task.runId, "failed", now().toISOString())) {
        logger.info({ runId: task.runId }, "local forward ended after the run was interrupted");
      }
      logger.error({ err: String(err) }, "local forward failed");
      return c.json({ error: "local runner unreachable" }, 502);
    }
  });

  return app;
}
