import { type EbbgateConfig, parseConfig } from "@ebbgate/core";

export function testConfig(args: {
  localRunner: string;
  cloudRunner: string;
  offlineAfterSeconds?: number;
  labelDeferred?: boolean;
}): EbbgateConfig {
  return parseConfig(
    {
      server: { port: 8790, publicUrl: "http://127.0.0.1:8790" },
      nodes: {
        mini: {
          runner: args.localRunner,
          token: "mini-token-0123456789abcdef",
          prefer: true,
        },
      },
      cloud: { runner: args.cloudRunner },
      paperclip: {
        apiUrl: "http://127.0.0.1:3100",
        apiKey: "pc-test-key-not-a-secret-value",
        sharedSecret: "shared-secret-0123456789abcdef",
        labelDeferred: args.labelDeferred ?? true,
      },
      agents: {
        agent_inbox: { tier: "private" },
        agent_ops: { tier: "internal" },
        agent_research: { tier: "public" },
      },
      policies: [
        {
          match: { label: "local-files" },
          available: "local",
          busy: "local-low",
          offline: "defer",
          notify: true,
        },
        {
          match: { tier: "private" },
          available: "local",
          busy: "local-low",
          offline: "defer",
        },
        {
          match: { tier: "internal" },
          available: "local",
          busy: "cloud",
          offline: "cloud",
        },
        {
          default: {
            available: "cloud",
            busy: "cloud",
            offline: "cloud",
          },
        },
      ],
      presence: {
        offlineAfterSeconds: args.offlineAfterSeconds ?? 90,
        drainConcurrency: 2,
        deferredMaxAgeHours: 72,
      },
    },
    {},
  );
}

export function runPayload(overrides: {
  runId: string;
  agentId: string;
  issueId?: string;
  labels?: string[];
}): Record<string, unknown> {
  return {
    runId: overrides.runId,
    agentId: overrides.agentId,
    context: {
      taskId: overrides.issueId ?? `issue-${overrides.runId}`,
      companyId: "company-test",
      wakeReason: "issue_assigned",
      commentId: null,
      labels: overrides.labels ?? [],
    },
    connectionInstructions: null,
  };
}

export function presenceBody(node = "mini"): Record<string, unknown> {
  return {
    node,
    mode: "auto",
    freeRamGb: 16,
    onBattery: false,
    userIdleSeconds: 120,
    modelsLoaded: [],
    modelsInstalled: ["llama3"],
    agentVersion: "0.0.0-test",
    sentAt: new Date().toISOString(),
  };
}

export const SECRET = "shared-secret-0123456789abcdef";
export const NODE_TOKEN = "mini-token-0123456789abcdef";
