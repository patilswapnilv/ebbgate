import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { bearerMatches } from "../auth.js";
import { countPendingDeferred } from "../services/queue.js";
import { listInFlightRuns, listRecentDecisions } from "../services/runs.js";

export function statusRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/status", (c) => {
    // v0.1: admin token = paperclip.sharedSecret (no separate admin secret in config).
    if (!bearerMatches(c.req.header("authorization"), c.get("config").paperclip.sharedSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const presence = c.get("presence");
    const db = c.get("db");
    return c.json({
      nodes: presence.listNodeStatuses(),
      queueDepth: countPendingDeferred(db),
      inFlight: listInFlightRuns(db),
      recentDecisions: listRecentDecisions(db, 20),
    });
  });

  return app;
}
