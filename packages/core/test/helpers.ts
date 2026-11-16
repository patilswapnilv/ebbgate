import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type EbbgateConfig, loadConfig } from "../src/config.js";
import { resolveTier } from "../src/policy.js";
import type { NodeStatus, PresenceReport, PresenceState, TaskContext } from "../src/types.js";

export const TEST_ENV = {
  EG_NODE_MINI_TOKEN: "mini-token-0123456789abcdef",
  EG_NODE_MBP_TOKEN: "mbp-token-0123456789abcdef",
  PAPERCLIP_API_KEY: "pc-test-key",
  EG_PAPERCLIP_SECRET: "shared-secret-0123456789abcdef",
  TG_BOT_TOKEN: "123:abc",
  TG_CHAT_ID: "42",
  EG_NOTIFY_WEBHOOK: "https://example.com/hook",
};

export const EXAMPLE_YAML = readFileSync(
  fileURLToPath(new URL("../../../ebbgate.example.yaml", import.meta.url)),
  "utf8",
);

export function exampleConfig(): EbbgateConfig {
  return loadConfig(EXAMPLE_YAML, TEST_ENV);
}

export function report(node: string, overrides: Partial<PresenceReport> = {}): PresenceReport {
  return {
    node,
    mode: "auto",
    freeRamGb: 8,
    onBattery: false,
    userIdleSeconds: 0,
    modelsLoaded: [],
    modelsInstalled: [],
    agentVersion: "0.0.0-test",
    sentAt: "2026-11-16T10:00:00.000Z",
    ...overrides,
  };
}

export function node(id: string, state: PresenceState, freeRamGb = 8): NodeStatus {
  return {
    node: id,
    state,
    lastSeenAt: state === "offline" ? null : "2026-11-16T10:00:00.000Z",
    report: state === "offline" ? null : report(id, { freeRamGb }),
  };
}

export function task(
  agentId: string,
  config: Pick<EbbgateConfig, "agents">,
  labels: string[] = [],
): TaskContext {
  return {
    runId: `run_${agentId}`,
    agentId,
    companyId: "company_test",
    issueId: "issue_1",
    tier: resolveTier(agentId, config),
    labels,
  };
}
