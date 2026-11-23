import type { PresenceMode } from "@ebbgate/core";
import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { bearerMatches } from "../auth.js";

const MODES = new Set<PresenceMode>(["auto", "busy", "available"]);

export function nodesRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/nodes/:id/mode", async (c) => {
    const id = c.req.param("id");
    const nodes = c.get("config").nodes;
    // Own keys only: ids like "constructor" must not resolve to Object.prototype members.
    const nodeCfg = Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    if (!nodeCfg) return c.json({ error: "unknown node" }, 404);
    if (!bearerMatches(c.req.header("authorization"), nodeCfg.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const mode =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { mode?: unknown }).mode
        : undefined;
    if (typeof mode !== "string" || !MODES.has(mode as PresenceMode)) {
      return c.json({ error: "mode must be auto|busy|available" }, 400);
    }

    await c.get("presence").setMode(id, mode as PresenceMode);
    return c.json({ ok: true, mode });
  });

  return app;
}
