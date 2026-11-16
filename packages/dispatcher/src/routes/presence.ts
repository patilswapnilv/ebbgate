import type { PresenceReport } from "@ebbgate/core";
import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { bearerMatches } from "../auth.js";

export function presenceRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/presence", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "body must be an object" }, 400);
    }
    const report = body as PresenceReport;
    if (typeof report.node !== "string" || !report.node) {
      return c.json({ error: "missing node" }, 400);
    }

    const nodeCfg = c.get("config").nodes[report.node];
    if (!nodeCfg) {
      return c.json({ error: "unknown node" }, 404);
    }
    if (!bearerMatches(c.req.header("authorization"), nodeCfg.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    try {
      await c.get("presence").applyReport(report);
    } catch (err) {
      c.get("logger").error({ err: String(err) }, "presence apply failed");
      return c.json({ error: "failed to apply presence" }, 500);
    }

    return c.json({ ok: true });
  });

  return app;
}
