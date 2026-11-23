import { parsePresenceReport } from "@ebbgate/core";
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

    // Authenticate first (needs only `node`), so unauthenticated callers learn nothing
    // about the report schema.
    const node =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { node?: unknown }).node
        : undefined;
    if (typeof node !== "string" || node.length === 0) {
      return c.json({ error: "missing node" }, 400);
    }
    const nodes = c.get("config").nodes;
    // Own keys only: ids like "constructor" must not resolve to Object.prototype members.
    const nodeCfg = Object.hasOwn(nodes, node) ? nodes[node] : undefined;
    if (!nodeCfg) return c.json({ error: "unknown node" }, 404);
    if (!bearerMatches(c.req.header("authorization"), nodeCfg.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // Then validate every field before anything is stored.
    const parsed = parsePresenceReport(body);
    if (!parsed.ok) {
      return c.json({ error: "invalid presence report", issues: parsed.issues }, 400);
    }

    try {
      await c.get("presence").applyReport(parsed.report);
    } catch (err) {
      c.get("logger").error({ err: String(err) }, "presence apply failed");
      return c.json({ error: "failed to apply presence" }, 500);
    }

    return c.json({ ok: true });
  });

  return app;
}
