import type { Decision, NodeStatus, TaskContext, Tier } from "@ebbgate/core";

export type DemoWriter = (line: string) => void;

/** True when EG_DEMO=1 (or "true"). Screen-recording-friendly plain-text logs. */
export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.EG_DEMO?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function createDemoWriter(enabled: boolean, write: DemoWriter = defaultWrite): DemoWriter {
  if (!enabled) return () => {};
  return write;
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function logDemoDecision(
  write: DemoWriter,
  args: {
    task: TaskContext;
    tier: Tier;
    nodes: readonly NodeStatus[];
    decision: Decision;
  },
): void {
  const { task, tier, nodes, decision } = args;
  const nodeSummary =
    nodes.length === 0 ? "none" : nodes.map((n) => `${n.node}=${n.state}`).join(" ");
  const action = formatAction(decision);

  write("┌─ ebbgate decision ─────────────────────────");
  write(`│  run     ${task.runId}`);
  write(`│  agent   ${task.agentId}`);
  if (task.issueId) write(`│  issue   ${task.issueId}`);
  write(`│  tier    ${tier}${task.labels.length ? `  labels=${task.labels.join(",")}` : ""}`);
  write(`│  nodes   ${nodeSummary}`);
  write(`│  action  ${action}`);
  write(`│  why     ${decision.why.code}: ${decision.why.text}`);
  write(`│  reason  ${decision.reason}`);
  write("└────────────────────────────────────────────");
}

export function logDemoPresence(
  write: DemoWriter,
  args: { node: string; from: string; to: string },
): void {
  write(`· presence  ${args.node}: ${args.from} → ${args.to}`);
}

function formatAction(decision: Decision): string {
  switch (decision.action) {
    case "local":
      return `LOCAL → ${decision.node} (${decision.priority})`;
    case "cloud":
      return "CLOUD";
    case "defer":
      return "DEFER (wait for local)";
  }
}
