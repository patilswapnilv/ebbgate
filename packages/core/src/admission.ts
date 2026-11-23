import { type EbbgateConfig, isDefaultRule } from "./config.js";
import { decide, mayRunInCloud, resolveTier } from "./policy.js";
import type { Decision, NodeId, NodeStatus, TaskContext, Tier } from "./types.js";

/**
 * Admission for an orchestrator that asks "may this run start in environment X?"
 * (for example Paperclip's per-environment `admissionCommand`). Pure: no I/O.
 *
 * The answer is derived from the same `decide()` the dispatcher uses, so an
 * environment is admitted only where the dispatcher itself would send the task.
 */

/** Where the environment being asked about actually runs. */
export type AdmissionTarget =
  | { kind: "node"; node: NodeId }
  /** Anything that is not one of your Ebbgate nodes: VPS, sandbox, cloud runtime. */
  | { kind: "remote" };

export interface AdmissionInput {
  /** Agent id if the orchestrator passed it. Missing means unknown: treated as private. */
  agentId?: string;
  /** Issue-level privacy flag. Can only make the task stricter, never relax it. */
  issuePrivate?: boolean;
  /** Task labels, if known. `undefined` means unknown: every label rule is considered. */
  labels?: readonly string[];
  target: AdmissionTarget;
}

export interface AdmissionResult {
  admit: boolean;
  tier: Tier;
  /** Human-readable, contains no secrets or payload content. */
  reason: string;
}

/** The tier used for admission: config tier, raised to private by any private signal. */
export function admissionTier(
  input: Pick<AdmissionInput, "agentId" | "issuePrivate">,
  config: Pick<EbbgateConfig, "agents">,
): Tier {
  if (input.issuePrivate) return "private";
  if (!input.agentId) return "private";
  return resolveTier(input.agentId, config);
}

/** Label sets to evaluate: exactly the known labels, or every label any rule mentions. */
function labelCandidates(
  labels: readonly string[] | undefined,
  config: Pick<EbbgateConfig, "policies">,
): string[][] {
  if (labels !== undefined) return [[...labels]];
  const ruleLabels = [
    ...new Set(
      config.policies.flatMap((r) =>
        !isDefaultRule(r) && r.match.label !== undefined ? [r.match.label] : [],
      ),
    ),
  ];
  return [[], ...ruleLabels.map((l) => [l]), ...(ruleLabels.length > 1 ? [ruleLabels] : [])];
}

function admitsTarget(decision: Decision, target: AdmissionTarget): boolean {
  if (target.kind === "node") return decision.action === "local" && decision.node === target.node;
  return decision.action === "cloud";
}

/**
 * Decide whether to admit a run into `target`.
 *
 * - A node environment is admitted only when the policy would run the task locally
 *   on that node (so an offline node is refused, and the orchestrator holds the run).
 * - A remote environment is admitted only when the policy would send the task to the
 *   cloud. Private and unknown tasks never are.
 * - With unknown labels, the run must be admitted under every label rule (stricter only).
 */
export function decideAdmission(
  input: AdmissionInput,
  nodes: readonly NodeStatus[],
  config: Pick<EbbgateConfig, "agents" | "nodes" | "policies">,
): AdmissionResult {
  const tier = admissionTier(input, config);

  if (input.target.kind === "node" && !Object.hasOwn(config.nodes, input.target.node)) {
    return { admit: false, tier, reason: `unknown node "${input.target.node}"` };
  }

  let last: Decision | undefined;
  for (const labels of labelCandidates(input.labels, config)) {
    const task: TaskContext = {
      runId: "admission",
      agentId: input.agentId ?? "(unknown)",
      companyId: "(unknown)",
      tier,
      labels,
    };
    const decision = decide(task, nodes, config);
    last = decision;
    if (!admitsTarget(decision, input.target)) {
      return {
        admit: false,
        tier,
        reason: `refused: ${decision.reason}${labels.length ? ` [labels=${labels.join(",")}]` : ""}`,
      };
    }
  }

  // Defense in depth: the private-never-remote invariant, independent of decide().
  if (input.target.kind === "remote" && !mayRunInCloud(tier)) {
    return { admit: false, tier, reason: "refused: private tasks never run remotely" };
  }

  return { admit: true, tier, reason: `admitted: ${last?.reason ?? "policy"}` };
}
