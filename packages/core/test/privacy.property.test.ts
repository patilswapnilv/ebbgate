import { describe, expect, it } from "vitest";
import { type EbbgateConfig, type PolicyRule, parseConfig } from "../src/config.js";
import { decide } from "../src/policy.js";
import type { NodeStatus, PolicyAction, PresenceState, TaskContext, Tier } from "../src/types.js";
import { node } from "./helpers.js";

/** Small seeded PRNG (mulberry32) so failures are reproducible without extra deps. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTIONS: PolicyAction[] = ["local", "local-low", "cloud", "defer"];
const OFFLINE: Array<"cloud" | "defer"> = ["cloud", "defer"];
const TIERS: Tier[] = ["private", "internal", "public"];
const LABELS = ["local-files", "urgent", "client-a"];
const STATES: PresenceState[] = ["available", "busy", "offline"];
const NODE_IDS = ["n1", "n2", "n3"];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

function randomRules(rand: () => number): PolicyRule[] {
  const count = 1 + Math.floor(rand() * 4);
  const rules: PolicyRule[] = [];
  for (let i = 0; i < count; i++) {
    const useTier = rand() < 0.7;
    const useLabel = !useTier || rand() < 0.3;
    rules.push({
      match: {
        ...(useTier ? { tier: pick(rand, TIERS) } : {}),
        ...(useLabel ? { label: pick(rand, LABELS) } : {}),
      },
      available: pick(rand, ACTIONS),
      busy: pick(rand, ACTIONS),
      offline: pick(rand, OFFLINE),
      notify: rand() < 0.5,
    });
  }
  rules.push({
    default: {
      available: pick(rand, ACTIONS),
      busy: pick(rand, ACTIONS),
      offline: pick(rand, OFFLINE),
      notify: false,
    },
  });
  return rules;
}

function baseRaw(policies: PolicyRule[]) {
  return {
    server: { publicUrl: "http://cloud:8790" },
    nodes: Object.fromEntries(
      NODE_IDS.map((id, i) => [
        id,
        { runner: `http://${id}:8787`, token: `token-${id}-0123456789`, prefer: i === 0 },
      ]),
    ),
    cloud: { runner: "http://openclaw:18789/paperclip" },
    paperclip: {
      apiUrl: "http://paperclip:3100",
      apiKey: "k",
      sharedSecret: "s".repeat(32),
    },
    agents: {},
    policies,
  };
}

function randomNodes(rand: () => number): NodeStatus[] {
  return NODE_IDS.map((id) => node(id, pick(rand, STATES), Math.floor(rand() * 32)));
}

function randomPrivateTask(rand: () => number): TaskContext {
  const labels = LABELS.filter(() => rand() < 0.4);
  return { runId: "r", agentId: "a", companyId: "c", tier: "private", labels };
}

describe("privacy invariant: private never runs in the cloud", () => {
  it("holds for every config that passes validation (5,000 random cases)", () => {
    const rand = prng(20261116);
    let validConfigs = 0;
    let checks = 0;

    for (let i = 0; i < 5000; i++) {
      let config: EbbgateConfig;
      try {
        config = parseConfig(baseRaw(randomRules(rand)));
      } catch {
        continue; // rejected by validation: that is the first line of defence
      }
      validConfigs++;
      for (let j = 0; j < 5; j++) {
        const d = decide(randomPrivateTask(rand), randomNodes(rand), config);
        expect(d.action, d.reason).not.toBe("cloud");
        checks++;
      }
    }

    // Make sure the generator actually exercised the engine.
    expect(validConfigs).toBeGreaterThan(200);
    expect(checks).toBeGreaterThan(1000);
  });

  it("holds even when validation is bypassed (runtime guard)", () => {
    const rand = prng(42);
    for (let i = 0; i < 2000; i++) {
      // Build an unvalidated config straight from random rules, including
      // rules that send private work to the cloud.
      const raw = baseRaw(randomRules(rand));
      const config = {
        nodes: Object.fromEntries(
          Object.entries(raw.nodes).map(([k, v]) => [k, { ...v, prefer: v.prefer }]),
        ),
        policies: raw.policies,
      } as Pick<EbbgateConfig, "nodes" | "policies">;

      const d = decide(randomPrivateTask(rand), randomNodes(rand), config);
      expect(d.action, d.reason).not.toBe("cloud");
    }
  });

  it("explains a guarded decision", () => {
    const config = {
      nodes: { n1: { runner: "http://n1:8787", token: "t".repeat(16), prefer: false } },
      policies: [
        { default: { available: "cloud", busy: "cloud", offline: "cloud", notify: false } },
      ],
    } as Pick<EbbgateConfig, "nodes" | "policies">;

    const d = decide(
      { runId: "r", agentId: "a", companyId: "c", tier: "private", labels: [] },
      [node("n1", "available")],
      config,
    );
    expect(d).toMatchObject({ action: "defer", notify: true });
    expect(d.reason).toMatch(/blocked: private tasks never run in the cloud/);
  });
});
