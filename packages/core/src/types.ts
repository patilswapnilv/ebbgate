/**
 * Core domain types for Ebbgate.
 *
 * Ebbgate decides, per agent task, whether work runs on a local machine,
 * on a cloud runtime, or waits ("defer") until a local machine returns.
 */

import type { DecisionReason } from "./reasons.js";

export type NodeId = string;

/** Derived state of a local node, as seen by the dispatcher. */
export type PresenceState = "available" | "busy" | "offline";

/** User override reported by the presence agent. `auto` lets Ebbgate decide. */
export type PresenceMode = "auto" | "busy" | "available";

/** Heartbeat sent by the presence agent on each local node. */
export interface PresenceReport {
  node: NodeId;
  mode: PresenceMode;
  freeRamGb: number;
  onBattery: boolean;
  userIdleSeconds: number;
  /** Models currently loaded in memory (Ollama `/api/ps`). */
  modelsLoaded: string[];
  /** Models installed on disk (Ollama `/api/tags`). */
  modelsInstalled: string[];
  agentVersion: string;
  /** ISO 8601 timestamp set by the agent. */
  sentAt: string;
}

/** What the dispatcher knows about a node at decision time. */
export interface NodeStatus {
  node: NodeId;
  state: PresenceState;
  /** ISO 8601 timestamp of the last accepted report, or null if never seen. */
  lastSeenAt: string | null;
  report: PresenceReport | null;
}

/**
 * Data sensitivity of a task.
 * - `private`: client data, PII, financials. Never leaves local machines.
 * - `internal`: your own plans and drafts. Local first, cloud allowed.
 * - `public`: public information, code, published content. Cloud is fine.
 */
export type Tier = "private" | "internal" | "public";

export const TIERS: readonly Tier[] = ["private", "internal", "public"] as const;

/** A task as Ebbgate sees it, after parsing the orchestrator's payload. */
export interface TaskContext {
  runId: string;
  agentId: string;
  companyId: string;
  issueId?: string;
  wakeReason?: string;
  /** Resolved from config by agent id. Never trusted from the incoming payload. */
  tier: Tier;
  labels: string[];
}

/**
 * What a policy rule says to do in a given presence state.
 * - `local`: run on an available node.
 * - `local-low`: run on an available or busy node, at low priority.
 * - `cloud`: run on the cloud runtime.
 * - `defer`: hold the task until a local node can take it.
 */
export type PolicyAction = "local" | "local-low" | "cloud" | "defer";

/** Actions allowed when no local node can take the work. */
export type OfflineAction = Extract<PolicyAction, "cloud" | "defer">;

/**
 * A routing decision. `reason` is a detailed trace for logs; `why` is the
 * structured, user-facing explanation (stable code + short sentence).
 */
export type Decision =
  | {
      action: "local";
      node: NodeId;
      priority: "normal" | "low";
      reason: string;
      rule: RuleRef;
      why: DecisionReason;
    }
  | { action: "cloud"; reason: string; rule: RuleRef; why: DecisionReason }
  | { action: "defer"; reason: string; notify: boolean; rule: RuleRef; why: DecisionReason };

/** Which policy rule produced a decision: its index, or "default". */
export type RuleRef = number | "default";
