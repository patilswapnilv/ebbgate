/**
 * Plain-text rendering of the dispatcher's `/status` and `/decisions` answers,
 * shared by `ebbgate status`, `ebbgate why` and `ebbgate decisions`. Pure.
 *
 * Inputs are untrusted JSON from the network, so every field is read defensively.
 */

export interface StatusWaiting {
  taskId: string;
  agentId?: string;
  issueId?: string | null;
  tier?: string;
  status?: string;
  since?: string;
  code: string;
  text: string;
}

export interface StatusDecision {
  id?: number;
  kind?: string;
  taskId?: string | null;
  agentId?: string | null;
  environmentId?: string | null;
  decision?: string;
  target?: string | null;
  tier?: string;
  code?: string;
  text?: string;
  rule?: string;
  presence?: string;
  decidedAt?: string;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "3m", "2h 5m", "4d 1h": how long ago `iso` was, relative to `now`. */
export function formatAge(iso: string | undefined, now: Date): string {
  if (!iso) return "?";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const STATE_ICON: Record<string, string> = { available: "●", busy: "◐", offline: "○" };

/** Lines for the dispatcher half of `ebbgate status`. */
export function formatDispatcherStatus(body: unknown, now: Date = new Date()): string[] {
  const b = obj(body);
  const lines: string[] = [];
  const presence = obj(b.presence);
  const nodes = arr(presence.nodes ?? b.nodes).map(obj);
  const overall = str(presence.overall, "unknown");
  lines.push(`presence: ${STATE_ICON[overall] ?? "?"} ${overall}`);
  for (const n of nodes) {
    const state = str(n.state, "unknown");
    const seen = str(n.lastSeenAt);
    lines.push(
      `  ${STATE_ICON[state] ?? "?"} ${str(n.node, "?")}: ${state}${seen ? ` (last seen ${formatAge(seen, now)} ago)` : " (never seen)"}`,
    );
  }

  const q = obj(b.queue);
  const held = num(q.held ?? b.queueDepth);
  lines.push(
    `queue: ${held} held (${num(q.pending)} pending, ${num(q.waking)} waking), ${num(q.done)} done, ${num(q.expired)} expired`,
  );

  const waiting = arr(b.waiting).map(obj);
  if (waiting.length === 0) {
    lines.push("waiting: nothing is waiting at the gate");
  } else {
    lines.push("waiting:");
    for (const w of waiting) {
      lines.push(
        `  ${str(w.taskId, "?")}  ${str(w.agentId, "?")}  ${str(w.tier, "?")}  ${formatAge(str(w.since), now)}  ${str(w.code, "?")}: ${str(w.text)}`,
      );
    }
    if (held > waiting.length) lines.push(`  … and ${held - waiting.length} more`);
  }
  const top = obj(b.topReason);
  if (typeof top.code === "string") {
    lines.push(`top reason: ${top.code} (${num(top.count)}): ${str(top.text)}`);
  }
  return lines;
}

/** One line per audit entry, newest first. */
export function formatDecisionLine(d: StatusDecision): string {
  const who =
    d.kind === "admission" ? `admission ${d.environmentId ?? ""}`.trim() : (d.taskId ?? "?");
  const target = d.target ? ` -> ${d.target}` : "";
  return `${d.decidedAt ?? "?"}  ${who}  ${d.agentId ?? "-"}  ${d.decision ?? "?"}${target}  [${d.tier ?? "?"}, ${d.presence ?? "?"}, rule ${d.rule ?? "?"}]  ${d.code ?? "?"}: ${d.text ?? ""}`;
}

/** The answer to `ebbgate why <taskId>`. */
export function formatWhy(taskId: string, body: unknown, now: Date = new Date()): string[] {
  const b = obj(body);
  const decisions = arr(b.decisions).map((d) => obj(d) as StatusDecision);
  const waiting = b.waiting ? (obj(b.waiting) as unknown as StatusWaiting) : null;
  if (decisions.length === 0 && !waiting) {
    return [`${taskId}: no decisions recorded (unknown task, or older than the audit retention)`];
  }
  const lines: string[] = [];
  const latest = decisions[0];
  if (waiting) {
    lines.push(
      `${taskId}: waiting for ${formatAge(waiting.since, now)}, ${waiting.code}: ${waiting.text}`,
    );
  } else if (latest) {
    lines.push(
      `${taskId}: ${latest.decision ?? "?"}${latest.target ? ` -> ${latest.target}` : ""}, ${latest.code ?? "?"}: ${latest.text ?? ""}`,
    );
  }
  if (decisions.length > 0) {
    lines.push("history (newest first):");
    for (const d of decisions) lines.push(`  ${formatDecisionLine(d)}`);
  }
  return lines;
}
