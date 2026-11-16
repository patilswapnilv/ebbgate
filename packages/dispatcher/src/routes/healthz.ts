import { Hono } from "hono";

export function healthzRoutes(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  return app;
}
