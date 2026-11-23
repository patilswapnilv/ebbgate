import type { PresenceState, RuleRef, Tier } from "./types.js";

/**
 * Structured, explainable reasons for every routing and admission decision.
 *
 * Each reason has a stable machine `code` (safe to match on in scripts, alerts and
 * dashboards) and a short human `text` ("held because it's private and your Mac is
 * offline"). Neither ever contains task payloads, prompts or secrets: only the
 * tier, the presence state, the rule index and node ids.
 */
export const REASON_CODES = {
  // Routing: ran locally
  RUN_LOCAL: "running on your Mac",
  RUN_LOCAL_LOW_MAC_BUSY: "running on your Mac at low priority because it's busy",
  // Routing: sent to the cloud
  RUN_CLOUD_POLICY: "sent to the cloud because the policy allows it",
  RUN_CLOUD_MAC_OFFLINE: "sent to the cloud because your Mac is offline",
  RUN_CLOUD_MAC_BUSY: "sent to the cloud because your Mac is busy",
  // Routing: held in the defer queue
  HELD_PRIVATE_MAC_OFFLINE: "held because it's private and your Mac is offline",
  HELD_PRIVATE_MAC_BUSY: "held because it's private and your Mac is busy",
  HELD_PRIVATE_CLOUD_BLOCKED: "held because private tasks never run in the cloud",
  HELD_MAC_OFFLINE: "held until your Mac is back, because the policy says to wait",
  HELD_MAC_BUSY: "held until your Mac is free, because the policy says to wait",
  HELD_POLICY: "held because the policy says to wait",
  HELD_NO_RULE: "held because no policy rule matched (safe fallback)",
  // Admission (Paperclip admissionCommand)
  ADMIT_NODE: "admitted: the policy runs this task on this node",
  ADMIT_REMOTE: "admitted: the policy allows this task to run remotely",
  REFUSE_UNKNOWN_NODE: "refused: this environment is not a configured Ebbgate node",
  REFUSE_PRIVATE_REMOTE: "refused: private tasks never run remotely",
  REFUSE_ROUTED_ELSEWHERE: "refused: the policy sends this task somewhere else",
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && Object.hasOwn(REASON_CODES, value);
}

/** Why a decision was made. Small, stable and free of payload data. */
export interface DecisionReason {
  code: ReasonCode;
  /** One short human sentence, e.g. "held because it's private and your Mac is offline". */
  text: string;
  tier: Tier;
  /** The overall presence state the policy reacted to. */
  presence: PresenceState;
  /** Which policy rule matched: its index, or "default". */
  rule: RuleRef;
}

/** Build a reason. `detail` is appended to the text in parentheses (rule, node id). */
export function reasonFor(
  code: ReasonCode,
  ctx: { tier: Tier; presence: PresenceState; rule: RuleRef; detail?: string },
): DecisionReason {
  const text = ctx.detail ? `${REASON_CODES[code]} (${ctx.detail})` : REASON_CODES[code];
  return { code, text, tier: ctx.tier, presence: ctx.presence, rule: ctx.rule };
}

/** "rule #2" or "default rule": how a rule is named in human text. */
export function describeRule(rule: RuleRef): string {
  return rule === "default" ? "default rule" : `rule #${rule}`;
}

/** True for every code that means "the task is waiting in the defer queue". */
export function isHeldCode(code: ReasonCode): boolean {
  return code.startsWith("HELD_");
}
