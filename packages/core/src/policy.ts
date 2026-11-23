import { type EbbgateConfig, isDefaultRule, type PolicyRule } from "./config.js";
import { type DecisionReason, describeRule, reasonFor } from "./reasons.js";
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
export function overallState(nodes: readonly NodeStatus[]): PresenceState {
  if (nodes.some((n) => n.state === "available")) return "available";
  if (nodes.some((n) => n.state === "busy")) return "busy";
  return "offline";
}

/** Why a task is held, given its tier and the presence state the policy saw. */
function heldReason(tier: Tier, state: PresenceState, rule: RuleRef): DecisionReason {
  const ctx = { tier, presence: state, rule, detail: describeRule(rule) };
  if (state === "offline")
    return reasonFor(tier === "private" ? "HELD_PRIVATE_MAC_OFFLINE" : "HELD_MAC_OFFLINE", ctx);
  if (state === "busy")
    return reasonFor(tier === "private" ? "HELD_PRIVATE_MAC_BUSY" : "HELD_MAC_BUSY", ctx);
  return reasonFor("HELD_POLICY", ctx);
}

/** Why a task went to the cloud, given the presence state the policy saw. */
function cloudReason(tier: Tier, state: PresenceState, rule: RuleRef): DecisionReason {
  const ctx = { tier, presence: state, rule, detail: describeRule(rule) };
  if (state === "offline") return reasonFor("RUN_CLOUD_MAC_OFFLINE", ctx);
  if (state === "busy") return reasonFor("RUN_CLOUD_MAC_BUSY", ctx);
  return reasonFor("RUN_CLOUD_POLICY", ctx);
}

/**
 * Decide where a task runs. Pure function: no I/O, no clock.
 *
 * Invariant: a `private` task is never sent to the cloud. Config validation
 * already rejects such rules; this function enforces it again at runtime.
 *
 * Every decision carries `why`: a stable reason code and a short sentence.
 */
export function decide(
  task: TaskContext,
  nodes: readonly NodeStatus[],
  config: Pick<EbbgateConfig, "nodes" | "policies">,
): Decision {
  const known = nodes.filter((n) => config.nodes[n.node] !== undefined);
  const index = config.policies.findIndex((r) => ruleMatches(r, task));
  const rule = config.policies[index];
  const state = overallState(known);

  if (!rule) {
    return guard(task, state, {
      action: "defer",
      notify: true,
      reason: "no policy rule matched; deferring as a safe fallback",
      rule: "default",
      why: reasonFor("HELD_NO_RULE", { tier: task.tier, presence: state, rule: "default" }),
    });
  }

  const ref: RuleRef = isDefaultRule(rule) ? "default" : index;
  const actions = isDefaultRule(rule) ? rule.default : rule;
  const notify = isDefaultRule(rule) ? rule.default.notify : rule.notify;
  const action: PolicyAction = actions[state];

  const describe = `rule ${ref === "default" ? "default" : `#${ref}`}, tier=${task.tier}, nodes=${state}`;

  if (action === "local" || action === "local-low") {
    const acceptable =
      action === "local"
        ? known.filter((n) => n.state === "available")
        : known.filter((n) => n.state === "available" || n.state === "busy");
    const node = pickNode(acceptable, config.nodes);
    if (node) {
      const priority = action === "local" ? "normal" : "low";
      const nodeBusy = known.find((n) => n.node === node)?.state === "busy";
      const ctx = { tier: task.tier, presence: state, rule: ref };
      return guard(task, state, {
        action: "local",
        node,
        priority,
        reason: `${describe} -> ${action} on ${node}`,
        rule: ref,
        why:
          priority === "low" && nodeBusy
            ? reasonFor("RUN_LOCAL_LOW_MAC_BUSY", { ...ctx, detail: node })
            : reasonFor("RUN_LOCAL", {
                ...ctx,
                detail: priority === "low" ? `${node}, low priority` : node,
              }),
      });
    }
    // No node can take it: fall through to the rule's offline action.
    return toOffline(
      task,
      state,
      actions.offline,
      notify,
      ref,
      `${describe} -> ${action}, no node free`,
    );
  }

  if (action === "cloud") {
    return guard(task, state, {
      action: "cloud",
      reason: `${describe} -> cloud`,
      rule: ref,
      why: cloudReason(task.tier, state, ref),
    });
  }

  return guard(task, state, {
    action: "defer",
    notify,
    reason: `${describe} -> defer`,
    rule: ref,
    why: heldReason(task.tier, state, ref),
  });
}

function toOffline(
  task: TaskContext,
  state: PresenceState,
  action: "cloud" | "defer",
  notify: boolean,
  rule: RuleRef,
  why: string,
): Decision {
  if (action === "cloud")
    return guard(task, state, {
      action: "cloud",
      reason: `${why} -> cloud`,
      rule,
      why: cloudReason(task.tier, state, rule),
    });
  return guard(task, state, {
    action: "defer",
    notify,
    reason: `${why} -> defer`,
    rule,
    why: heldReason(task.tier, state, rule),
  });
}

/** Defense in depth: never let a private task reach the cloud. */
function guard(task: TaskContext, state: PresenceState, decision: Decision): Decision {
  if (task.tier === "private" && decision.action === "cloud") {
    return {
      action: "defer",
      notify: true,
      reason: `${decision.reason}; blocked: private tasks never run in the cloud`,
      rule: decision.rule,
      why: reasonFor("HELD_PRIVATE_CLOUD_BLOCKED", {
        tier: task.tier,
        presence: state,
        rule: decision.rule,
        detail: describeRule(decision.rule),
      }),
    };
  }
  return decision;
}
