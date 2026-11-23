import { describe, expect, it } from "vitest";
import { decideAdmission } from "../src/admission.js";
import { type EbbgateConfig, parseConfig } from "../src/config.js";
import { decide } from "../src/policy.js";
import { isHeldCode, isReasonCode, REASON_CODES, reasonFor } from "../src/reasons.js";
import type { PresenceState, TaskContext, Tier } from "../src/types.js";
import { exampleConfig, node, task } from "./helpers.js";

const STATES: PresenceState[] = ["available", "busy", "offline"];

function cfg(policies: unknown[], agents: Record<string, { tier: Tier }> = {}): EbbgateConfig {
  return parseConfig({
    server: { publicUrl: "http://127.0.0.1:8790" },
    nodes: { mini: { runner: "http://127.0.0.1:1/run", token: "mini-token-0123456789abcdef" } },
    cloud: { runner: "http://127.0.0.1:2/run" },
    paperclip: {
      apiUrl: "http://127.0.0.1:3100",
      apiKey: "k",
      sharedSecret: "shared-secret-0123456789abcdef",
    },
    agents,
    policies,
  });
}

const t = (tier: Tier, labels: string[] = []): TaskContext => ({
  runId: "run_secret_payload_marker",
  agentId: "agent_marker",
  companyId: "company_marker",
  tier,
  labels,
});

describe("decision reasons: decide()", () => {
  const config = exampleConfig();

  it("private + Mac offline is HELD_PRIVATE_MAC_OFFLINE with the plain sentence", () => {
    const d = decide(task("agent_inbox", config), [node("mini", "offline")], config);
    expect(d.action).toBe("defer");
    expect(d.why.code).toBe("HELD_PRIVATE_MAC_OFFLINE");
    expect(d.why.text).toBe("held because it's private and your Mac is offline (rule #1)");
    expect(d.why).toMatchObject({ tier: "private", presence: "offline", rule: 1 });
  });

  it("private + Mac available runs locally, naming the node", () => {
    const d = decide(task("agent_inbox", config), [node("mini", "available")], config);
    expect(d.why.code).toBe("RUN_LOCAL");
    expect(d.why.text).toContain("(mini)");
  });

  it("private + Mac busy with local-low runs at low priority", () => {
    const d = decide(task("agent_inbox", config), [node("mini", "busy")], config);
    expect(d).toMatchObject({ action: "local", priority: "low" });
    expect(d.why.code).toBe("RUN_LOCAL_LOW_MAC_BUSY");
  });

  it("internal tasks name why they went to the cloud", () => {
    expect(decide(task("agent_ops", config), [node("mini", "offline")], config).why.code).toBe(
      "RUN_CLOUD_MAC_OFFLINE",
    );
    expect(decide(task("agent_ops", config), [node("mini", "busy")], config).why.code).toBe(
      "RUN_CLOUD_MAC_BUSY",
    );
    expect(
      decide(task("agent_research", config), [node("mini", "available")], config).why.code,
    ).toBe("RUN_CLOUD_POLICY");
  });

  it("private + busy with a defer rule is HELD_PRIVATE_MAC_BUSY", () => {
    const c = cfg([
      { match: { tier: "private" }, available: "local", busy: "defer", offline: "defer" },
      { default: { available: "local", busy: "defer", offline: "defer" } },
    ]);
    expect(decide(t("private"), [node("mini", "busy")], c).why.code).toBe("HELD_PRIVATE_MAC_BUSY");
    expect(decide(t("internal"), [node("mini", "busy")], c).why.code).toBe("HELD_MAC_BUSY");
    expect(decide(t("internal"), [node("mini", "offline")], c).why.code).toBe("HELD_MAC_OFFLINE");
  });

  it("a rule that defers even while the Mac is available is HELD_POLICY", () => {
    const c = cfg([{ default: { available: "defer", busy: "defer", offline: "defer" } }]);
    const d = decide(t("public"), [node("mini", "available")], c);
    expect(d.why.code).toBe("HELD_POLICY");
    expect(d.why.rule).toBe("default");
  });

  it("no matching rule is HELD_NO_RULE", () => {
    const c = cfg([{ default: { available: "defer", busy: "defer", offline: "defer" } }]);
    const d = decide(t("public"), [node("mini", "offline")], { ...c, policies: [] });
    expect(d.why.code).toBe("HELD_NO_RULE");
  });

  it("the runtime guard explains itself: HELD_PRIVATE_CLOUD_BLOCKED", () => {
    // Bypass config validation to reach the defense-in-depth guard.
    const valid = cfg([{ default: { available: "defer", busy: "defer", offline: "defer" } }]);
    const c = {
      ...valid,
      policies: [
        { default: { available: "cloud", busy: "cloud", offline: "cloud", notify: false } },
      ],
    } as EbbgateConfig;
    const d = decide(t("private"), [node("mini", "offline")], c);
    expect(d.action).toBe("defer");
    expect(d.why.code).toBe("HELD_PRIVATE_CLOUD_BLOCKED");
  });

  it("every decision's code agrees with its action and never leaks task data", () => {
    for (const tier of ["private", "internal", "public"] as Tier[]) {
      for (const state of STATES) {
        for (const labels of [[], ["local-files"]]) {
          const d = decide(t(tier, labels), [node("mini", state)], config);
          expect(isReasonCode(d.why.code)).toBe(true);
          expect(d.why.tier).toBe(tier);
          if (d.action === "defer") expect(isHeldCode(d.why.code)).toBe(true);
          if (d.action === "cloud") expect(d.why.code.startsWith("RUN_CLOUD")).toBe(true);
          if (d.action === "local") expect(d.why.code.startsWith("RUN_LOCAL")).toBe(true);
          if (tier === "private") expect(d.action).not.toBe("cloud");
          expect(d.why.text).not.toMatch(/marker/);
        }
      }
    }
  });
});

describe("decision reasons: decideAdmission()", () => {
  const config = exampleConfig();
  const mac = { kind: "node", node: "mini" } as const;

  it("unknown node", () => {
    const r = decideAdmission(
      { agentId: "agent_ops", target: { kind: "node", node: "nope" } },
      [],
      config,
    );
    expect(r.why.code).toBe("REFUSE_UNKNOWN_NODE");
  });

  it("private to remote is REFUSE_PRIVATE_REMOTE", () => {
    const r = decideAdmission(
      { agentId: "agent_inbox", labels: [], target: { kind: "remote" } },
      [node("mini", "available")],
      config,
    );
    expect(r.admit).toBe(false);
    expect(r.why.code).toBe("REFUSE_PRIVATE_REMOTE");
  });

  it("a held task keeps its HELD reason when refused on the Mac", () => {
    const r = decideAdmission(
      { agentId: "agent_inbox", labels: [], target: mac },
      [node("mini", "offline")],
      config,
    );
    expect(r.admit).toBe(false);
    expect(r.why.code).toBe("HELD_PRIVATE_MAC_OFFLINE");
  });

  it("routed elsewhere, and both admit codes", () => {
    const elsewhere = decideAdmission(
      { agentId: "agent_ops", labels: [], target: mac },
      [node("mini", "offline")],
      config,
    );
    expect(elsewhere.why.code).toBe("REFUSE_ROUTED_ELSEWHERE");
    expect(elsewhere.why.text).toContain("cloud");
    const onMac = decideAdmission(
      { agentId: "agent_inbox", labels: [], target: mac },
      [node("mini", "available")],
      config,
    );
    expect(onMac).toMatchObject({ admit: true, why: { code: "ADMIT_NODE" } });
    const remote = decideAdmission(
      { agentId: "agent_ops", labels: [], target: { kind: "remote" } },
      [node("mini", "offline")],
      config,
    );
    expect(remote).toMatchObject({
      admit: true,
      why: { code: "ADMIT_REMOTE", presence: "offline" },
    });
  });
});

describe("reason vocabulary", () => {
  it("every code has a short sentence and HELD_ codes say 'held'", () => {
    for (const [code, text] of Object.entries(REASON_CODES)) {
      expect(code).toMatch(/^[A-Z_]+$/);
      expect(text.length).toBeLessThan(90);
      if (code.startsWith("HELD_")) expect(text.startsWith("held")).toBe(true);
    }
  });

  it("reasonFor appends detail", () => {
    expect(
      reasonFor("RUN_LOCAL", { tier: "public", presence: "available", rule: 0, detail: "mini" })
        .text,
    ).toBe("running on your Mac (mini)");
  });
});

describe("audit config", () => {
  const base = (audit: unknown) => ({
    server: { publicUrl: "http://127.0.0.1:8790" },
    nodes: { mini: { runner: "http://127.0.0.1:1/run", token: "mini-token-0123456789abcdef" } },
    cloud: { runner: "http://127.0.0.1:2/run" },
    paperclip: {
      apiUrl: "http://127.0.0.1:3100",
      apiKey: "k",
      sharedSecret: "shared-secret-0123456789abcdef",
    },
    policies: [{ default: { available: "local", busy: "defer", offline: "defer" } }],
    ...(audit === undefined ? {} : { audit }),
  });

  it("is optional and validated", () => {
    expect(parseConfig(base(undefined)).audit).toBeUndefined();
    expect(parseConfig(base({ retentionDays: 7, maxRows: 5000 })).audit).toEqual({
      retentionDays: 7,
      maxRows: 5000,
    });
    expect(() => parseConfig(base({ retentionDays: 0 }))).toThrow();
    expect(() => parseConfig(base({ maxRows: 10 }))).toThrow();
    expect(() => parseConfig(base({ other: 1 }))).toThrow();
  });
});
