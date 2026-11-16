import { type EbbgateConfig, isDefaultRule, type PolicyRule } from "./config.js";
import type {
  Decision,
  NodeId,
  NodeStatus,
  PolicyAction,
  PresenceReport,
  PresenceState,
  RuleRef,
  TaskContext,
  Tier,
} from "./types.js";

/**
 * Resolve a task's tier from config. The tier is never taken from the
 * incoming payload. Unknown agents are treated as `private` (fail closed).
 */
export function resolveTier(agentId: string, config: Pick<EbbgateConfig, "agents">): Tier {
  return config.agents[agentId]?.tier ?? "private";
}

/**
 * Derive a node's presence state from its last report.
 * Pure: the caller passes `now`.
 */
export function deriveState(
  report: PresenceReport | null,
  lastSeenAt: string | null,
  now: Date,
  offlineAfterSeconds: number,
): PresenceState {
  if (!report || !lastSeenAt) return "offline";
  const ageMs = now.getTime() - new Date(lastSeenAt).getTime();
  if (Number.isNaN(ageMs) || ageMs > offlineAfterSeconds * 1000) return "offline";
  if (report.mode === "busy") return "busy";
  if (report.mode === "available") return "available";
  return report.onBattery ? "busy" : "available";
}

function ruleMatches(rule: PolicyRule, task: TaskContext): boolean {
  if (isDefaultRule(rule)) return true;
  const { tier, label } = rule.match;
  if (tier !== undefined && tier !== task.tier) return false;
  if (label !== undefined && !task.labels.includes(label)) return false;
  return true;
}

/** Pick a node: preferred first, then most free RAM, then id (deterministic). */
function pickNode(
  candidates: readonly NodeStatus[],
  nodesConfig: EbbgateConfig["nodes"],
): NodeId | undefined {
  const sorted = [...candidates].sort((a, b) => {
    const pa = nodesConfig[a.node]?.prefer ? 1 : 0;
    const pb = nodesConfig[b.node]?.prefer ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ra = a.report?.freeRamGb ?? 0;
    const rb = b.report?.freeRamGb ?? 0;
    if (ra !== rb) return rb - ra;
    return a.node.localeCompare(b.node);
  });
  return sorted[0]?.node;
}

/** The single state the policy reacts to, across all configured nodes. */
function overallState(nodes: readonly NodeStatus[]): PresenceState {
  if (nodes.some((n) => n.state === "available")) return "available";
  if (nodes.some((n) => n.state === "busy")) return "busy";
  return "offline";
}

/**
 * Decide where a task runs. Pure function: no I/O, no clock.
 *
 * Invariant: a `private` task is never sent to the cloud. Config validation
 * already rejects such rules; this function enforces it again at runtime.
 */
export function decide(
  task: TaskContext,
  nodes: readonly NodeStatus[],
  config: Pick<EbbgateConfig, "nodes" | "policies">,
): Decision {
  const known = nodes.filter((n) => config.nodes[n.node] !== undefined);
  const index = config.policies.findIndex((r) => ruleMatches(r, task));
  const rule = config.policies[index];

  if (!rule) {
    return guard(task, {
      action: "defer",
      notify: true,
      reason: "no policy rule matched; deferring as a safe fallback",
      rule: "default",
    });
  }

  const ref: RuleRef = isDefaultRule(rule) ? "default" : index;
  const actions = isDefaultRule(rule) ? rule.default : rule;
  const notify = isDefaultRule(rule) ? rule.default.notify : rule.notify;
  const state = overallState(known);
  const action: PolicyAction = actions[state];

  const describe = `rule ${ref === "default" ? "default" : `#${ref}`}, tier=${task.tier}, nodes=${state}`;

  if (action === "local" || action === "local-low") {
    const acceptable =
      action === "local"
        ? known.filter((n) => n.state === "available")
        : known.filter((n) => n.state === "available" || n.state === "busy");
    const node = pickNode(acceptable, config.nodes);
    if (node) {
      return guard(task, {
        action: "local",
        node,
        priority: action === "local" ? "normal" : "low",
        reason: `${describe} -> ${action} on ${node}`,
        rule: ref,
      });
    }
    // No node can take it: fall through to the rule's offline action.
    return toOffline(task, actions.offline, notify, ref, `${describe} -> ${action}, no node free`);
  }

  if (action === "cloud") {
    return guard(task, { action: "cloud", reason: `${describe} -> cloud`, rule: ref });
  }

  return guard(task, { action: "defer", notify, reason: `${describe} -> defer`, rule: ref });
}

function toOffline(
  task: TaskContext,
  action: "cloud" | "defer",
  notify: boolean,
  rule: RuleRef,
  why: string,
): Decision {
  if (action === "cloud") return guard(task, { action: "cloud", reason: `${why} -> cloud`, rule });
  return guard(task, { action: "defer", notify, reason: `${why} -> defer`, rule });
}

/** Defense in depth: never let a private task reach the cloud. */
function guard(task: TaskContext, decision: Decision): Decision {
  if (task.tier === "private" && decision.action === "cloud") {
    return {
      action: "defer",
      notify: true,
      reason: `${decision.reason}; blocked: private tasks never run in the cloud`,
      rule: decision.rule,
    };
  }
  return decision;
}
