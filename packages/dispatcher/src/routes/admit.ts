import { type AdmissionInput, decideAdmission } from "@ebbgate/core";
import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { bearerMatches } from "../auth.js";
import { auditAdmission } from "../services/audit.js";

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_LABELS = 32;

/** Strict parse; anything unexpected is a 400 so callers fail closed. */
export function parseAdmitBody(body: unknown): AdmissionInput | string {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return "body must be an object";
  const b = body as Record<string, unknown>;
  const allowed = new Set(["agentId", "environmentId", "issuePrivate", "labels", "node", "target"]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) return `unexpected field "${k}"`;

  if (b.agentId !== undefined && (typeof b.agentId !== "string" || !ID.test(b.agentId)))
    return "invalid agentId";
  if (
    b.environmentId !== undefined &&
    (typeof b.environmentId !== "string" || !ID.test(b.environmentId))
  )
    return "invalid environmentId";
  if (b.issuePrivate !== undefined && typeof b.issuePrivate !== "boolean")
    return "invalid issuePrivate";
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels) || b.labels.length > MAX_LABELS) return "invalid labels";
    if (!b.labels.every((l) => typeof l === "string" && l.length > 0 && l.length <= 64))
      return "invalid labels";
  }
  let target: AdmissionInput["target"];
  if (b.target === "remote") {
    if (b.node !== undefined) return "node is only valid with target=node";
    target = { kind: "remote" };
  } else if (b.target === "node") {
    if (typeof b.node !== "string" || !ID.test(b.node)) return "invalid node";
    target = { kind: "node", node: b.node };
  } else {
    return 'target must be "node" or "remote"';
  }
  return {
    ...(typeof b.agentId === "string" ? { agentId: b.agentId } : {}),
    ...(b.issuePrivate === true ? { issuePrivate: true } : {}),
    ...(Array.isArray(b.labels) ? { labels: b.labels as string[] } : {}),
    target,
  };
}

/**
 * POST /admit: admission check for orchestrators (Paperclip `admissionCommand`
 * via `ebbgate admit`). Creates no run and forwards nothing; the answer is
 * appended to the audit log (ids and reason codes only).
 */
export function admitRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/admit", async (c) => {
    // Same admin credential as /status (v0.1 has one shared secret).
    if (!bearerMatches(c.req.header("authorization"), c.get("config").paperclip.sharedSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const input = parseAdmitBody(body);
    if (typeof input === "string") return c.json({ error: input }, 400);

    const result = decideAdmission(input, c.get("presence").listNodeStatuses(), c.get("config"));
    const target = input.target.kind === "node" ? input.target.node : "remote";
    const environmentId =
      typeof (body as { environmentId?: unknown }).environmentId === "string"
        ? (body as { environmentId: string }).environmentId
        : undefined;
    try {
      auditAdmission(c.get("db"), {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(environmentId ? { environmentId } : {}),
        target,
        result,
        decidedAt: c.get("now")().toISOString(),
      });
    } catch (err) {
      // Auditing must never change the admission answer.
      c.get("logger").warn({ err: String(err) }, "admission audit write failed");
    }
    c.get("logger").info(
      {
        admit: result.admit,
        tier: result.tier,
        code: result.why.code,
        target,
        agentId: input.agentId ?? null,
        environmentId: environmentId ?? null,
      },
      "admission check",
    );
    return c.json(result);
  });

  return app;
}
