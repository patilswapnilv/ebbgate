import type { TaskContextInput } from "./types.js";

/**
 * Parse a Paperclip http-adapter webhook body into TaskContextInput.
 *
 * Confirmed (docs.paperclip.ing/reference/adapters/http/): runId, agentId,
 * context.taskId, context.wakeReason, context.commentId, connectionInstructions.
 *
 * TODO(verify-paperclip): whether context includes companyId and labels.
 * Until confirmed we read them when present and otherwise use safe defaults.
 */
export function parseRun(body: unknown, _headers: Headers): TaskContextInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ParseError("body must be a JSON object");
  }
  const o = body as Record<string, unknown>;
  const runId = requireString(o, "runId");
  const agentId = requireString(o, "agentId");

  const ctx =
    o.context !== null && typeof o.context === "object" && !Array.isArray(o.context)
      ? (o.context as Record<string, unknown>)
      : {};

  // TODO(verify-paperclip): context.taskId is the issue id in documented examples.
  const taskId = optionalString(ctx, "taskId");
  const companyId = optionalString(ctx, "companyId") ?? "";
  const wakeReason = optionalString(ctx, "wakeReason");
  const labels = parseLabels(ctx.labels);

  const input: TaskContextInput = {
    runId,
    agentId,
    companyId,
    labels,
  };
  if (taskId !== undefined) input.issueId = taskId;
  if (wakeReason !== undefined) input.wakeReason = wakeReason;
  return input;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ParseError(`missing or invalid ${key}`);
  }
  return v;
}

function optionalString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ParseError(`invalid ${key}`);
  return v;
}

function parseLabels(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ParseError("context.labels must be an array of strings");
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string")
      throw new ParseError("context.labels must be an array of strings");
    out.push(item);
  }
  return out;
}
