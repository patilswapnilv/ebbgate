import { describe, expect, it } from "vitest";
import { decideAdmission } from "../src/admission.js";
import { type EbbgateConfig, type PolicyRule, parseConfig } from "../src/config.js";
import type { NodeStatus, PolicyAction, PresenceState, Tier } from "../src/types.js";
import { exampleConfig, node } from "./helpers.js";

const mac = { kind: "node", node: "mini" } as const;
const remote = { kind: "remote" } as const;

describe("decideAdmission (example config)", () => {
  const config = exampleConfig();
  const agents = Object.entries(config.agents);
  const privateAgent = agents.find(([, a]) => a.tier === "private")?.[0] as string;
  const internalAgent = agents.find(([, a]) => a.tier === "internal")?.[0] as string;
  const publicAgent = agents.find(([, a]) => a.tier === "public")?.[0] as string;

  it("has one agent per tier to test with", () => {
    expect([privateAgent, internalAgent, publicAgent].every(Boolean)).toBe(true);
  });

  it("private + Mac available: admits the Mac, refuses remote", () => {
    const nodes = [node("mini", "available")];
    const labels: string[] = [];
    expect(
      decideAdmission({ agentId: privateAgent, labels, target: mac }, nodes, config).admit,
    ).toBe(true);
    expect(
      decideAdmission({ agentId: privateAgent, labels, target: remote }, nodes, config).admit,
    ).toBe(false);
  });

  it("private + Mac offline: refused everywhere (the orchestrator holds the run)", () => {
    const nodes = [node("mini", "offline")];
    const a = decideAdmission({ agentId: privateAgent, labels: [], target: mac }, nodes, config);
    const b = decideAdmission({ agentId: privateAgent, labels: [], target: remote }, nodes, config);
    expect(a.admit).toBe(false);
    expect(b.admit).toBe(false);
    expect(b.tier).toBe("private");
  });

  it("internal + Mac offline: refuses the Mac, admits remote", () => {
    const nodes = [node("mini", "offline")];
    expect(
      decideAdmission({ agentId: internalAgent, labels: [], target: mac }, nodes, config).admit,
    ).toBe(false);
    expect(
      decideAdmission({ agentId: internalAgent, labels: [], target: remote }, nodes, config).admit,
    ).toBe(true);
  });

  it("unknown or missing agent is private", () => {
    const nodes = [node("mini", "offline")];
    for (const agentId of [undefined, "agent_nobody"]) {
      const r = decideAdmission(
        { ...(agentId ? { agentId } : {}), labels: [], target: remote },
        nodes,
        config,
      );
      expect(r.admit).toBe(false);
      expect(r.tier).toBe("private");
    }
  });

  it("issue privacy flag only makes it stricter", () => {
    const nodes = [node("mini", "offline")];
    const r = decideAdmission(
      { agentId: publicAgent, issuePrivate: true, labels: [], target: remote },
      nodes,
      config,
    );
    expect(r.admit).toBe(false);
    expect(r.tier).toBe("private");
  });

  it("unknown labels are evaluated against every label rule (stricter only)", () => {
    const nodes = [node("mini", "offline")];
    // With labels known to be empty, internal work may go remote...
    expect(
      decideAdmission({ agentId: internalAgent, labels: [], target: remote }, nodes, config).admit,
    ).toBe(true);
    // ...but with labels unknown, a `local-files` rule that defers could apply: refuse.
    const hasLocalFiles = config.policies.some(
      (r) => "match" in r && r.match.label === "local-files",
    );
    if (hasLocalFiles) {
      expect(decideAdmission({ agentId: internalAgent, target: remote }, nodes, config).admit).toBe(
        false,
      );
    }
  });

  it("refuses an unknown node environment", () => {
    const r = decideAdmission(
      { agentId: privateAgent, labels: [], target: { kind: "node", node: "nope" } },
      [node("mini", "available")],
      config,
    );
    expect(r.admit).toBe(false);
  });
});

/* Property test: random valid configs and presence. */
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
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;
const ACTIONS: PolicyAction[] = ["local", "local-low", "cloud", "defer"];
const OFFLINE: Array<"cloud" | "defer"> = ["cloud", "defer"];
const TIERS: Tier[] = ["private", "internal", "public"];
const LABELS = ["local-files", "urgent"];
const STATES: PresenceState[] = ["available", "busy", "offline"];
const NODE_IDS = ["n1", "n2"];

function randomConfig(r: () => number): EbbgateConfig | null {
  const rules: PolicyRule[] = [];
  for (let i = 0; i < 1 + Math.floor(r() * 3); i++) {
    rules.push({
      match: r() < 0.6 ? { tier: pick(r, TIERS) } : { label: pick(r, LABELS) },
      available: pick(r, ACTIONS),
      busy: pick(r, ACTIONS),
      offline: pick(r, OFFLINE),
      notify: false,
    });
  }
  rules.push({
    default: {
      available: pick(r, ACTIONS),
      busy: pick(r, ACTIONS),
      offline: pick(r, OFFLINE),
      notify: false,
    },
  });
  try {
    return parseConfig({
      server: { publicUrl: "http://cloud:8790" },
      nodes: Object.fromEntries(
        NODE_IDS.map((id) => [
          id,
          { runner: `http://${id}:8787`, token: `token-${id}-0123456789` },
        ]),
      ),
      cloud: { runner: "http://cloud:18789" },
      paperclip: { apiUrl: "http://paperclip:3100", apiKey: "k", sharedSecret: "s".repeat(32) },
      agents: {
        a_priv: { tier: "private" },
        a_int: { tier: "internal" },
        a_pub: { tier: "public" },
      },
      policies: rules,
    });
  } catch {
    return null;
  }
}

describe("admission invariants (random configs)", () => {
  it("never admits private/unknown remotely, never admits an offline node", () => {
    const r = prng(20261123);
    let checks = 0;
    for (let i = 0; i < 3000; i++) {
      const config = randomConfig(r);
      if (!config) continue;
      const nodes: NodeStatus[] = NODE_IDS.map((id) => node(id, pick(r, STATES)));
      const agentId = pick(r, ["a_priv", "a_int", "a_pub", "unknown", undefined]);
      const issuePrivate = r() < 0.2;
      const labels = r() < 0.5 ? undefined : LABELS.filter(() => r() < 0.4);
      const input = {
        ...(agentId ? { agentId } : {}),
        issuePrivate,
        ...(labels ? { labels } : {}),
      };

      const rem = decideAdmission({ ...input, target: remote }, nodes, config);
      if (agentId !== "a_int" && agentId !== "a_pub") expect(rem.admit).toBe(false);
      if (issuePrivate) expect(rem.admit).toBe(false);

      for (const n of nodes) {
        const loc = decideAdmission(
          { ...input, target: { kind: "node", node: n.node } },
          nodes,
          config,
        );
        if (n.state === "offline") expect(loc.admit).toBe(false);
      }
      checks++;
    }
    expect(checks).toBeGreaterThan(300);
  });
});
