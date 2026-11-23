/**
 * Privacy guarantee, configuration: a policy file that is missing, malformed,
 * or written to leak is rejected before the dispatcher can route anything.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../../src/config.js";
import { decide, resolveTier } from "../../src/policy.js";
import { node } from "../helpers.js";

const BASE = `
server: { publicUrl: "http://cloud:8790" }
nodes:
  mini: { runner: "http://mini:8787/run", token: "mini-token-0123456789" }
cloud: { runner: "http://openclaw:18789/paperclip" }
paperclip: { apiUrl: "http://paperclip:3100", apiKey: "k", sharedSecret: "s-0123456789abcdef" }
`;
const SAFE_POLICIES = `
policies:
  - match: { tier: private }
    available: local
    busy: local-low
    offline: defer
  - default: { available: cloud, busy: cloud, offline: cloud }
`;

function rejects(yaml: string, env: Record<string, string> = {}): ConfigError {
  try {
    loadConfig(yaml, env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("config was accepted");
}

describe("privacy guarantee: configuration", () => {
  it("a missing or empty policy file is rejected (no implicit allow-all)", () => {
    rejects("");
    rejects("   \n");
    rejects("null");
    rejects(BASE); // no policies at all
    rejects(`${BASE}\npolicies: []\n`);
  });

  it("invalid YAML is rejected, without echoing file content", () => {
    const err = rejects(`${BASE}\npolicies: [ {match: {tier: private}, available: local\n`);
    expect(err.message).not.toContain("s-0123456789abcdef");
  });

  it("an unresolved environment reference is rejected rather than left empty", () => {
    rejects(`${BASE.replace('"s-0123456789abcdef"', `"$${"{"}MISSING_SECRET}"`)}${SAFE_POLICIES}`);
  });

  it("every rule shape that could send private work to the cloud is rejected", () => {
    const leaky = [
      // default rule can see private
      `policies:\n  - default: { available: local, busy: cloud, offline: defer }`,
      // label-only rule before private is captured
      `policies:\n  - match: { label: ok }\n    available: cloud\n    busy: local\n    offline: defer\n  - match: { tier: private }\n    available: local\n    busy: local\n    offline: defer\n  - default: { available: cloud, busy: cloud, offline: cloud }`,
      // tier+label rule does not capture every private task
      `policies:\n  - match: { tier: private, label: x }\n    available: local\n    busy: local\n    offline: defer\n  - default: { available: local, busy: local, offline: cloud }`,
      // private rule that itself goes cloud offline
      `policies:\n  - match: { tier: private }\n    available: local\n    busy: local\n    offline: cloud\n  - default: { available: cloud, busy: cloud, offline: cloud }`,
    ];
    for (const p of leaky) rejects(`${BASE}${p}\n`);
  });

  it("malformed tiers and unknown keys are rejected, not coerced", () => {
    for (const tier of ["Private", "PUBLIC", "secret", "''", "null", "1", "[public]"]) {
      rejects(`${BASE}agents:\n  a: { tier: ${tier} }\n${SAFE_POLICIES}`);
    }
    rejects(`${BASE}agents:\n  a: { tier: public, private: false }\n${SAFE_POLICIES}`);
    rejects(`${BASE}agents:\n  a: public\n${SAFE_POLICIES}`);
    rejects(`${BASE}agents:\n  a: {}\n${SAFE_POLICIES}`);
    rejects(
      `${BASE}${SAFE_POLICIES}  - match: { tier: private }\n    available: local\n    busy: local\n    offline: defer\n    allowCloud: true\n`,
    );
  });

  it("FIXED: a node whose runner is the cloud runner is rejected (it would make 'local' mean cloud)", () => {
    const variants = [
      "http://openclaw:18789/paperclip",
      "http://openclaw:18789/paperclip/",
      "http://OPENCLAW:18789/paperclip",
    ];
    for (const runner of variants) {
      const err = rejects(
        `${BASE.replace('"http://mini:8787/run"', `"${runner}"`)}${SAFE_POLICIES}`,
      );
      expect(err.issues.map((i) => i.path)).toContain("nodes.mini.runner");
    }
    // Same host, different port or path, is a different runner (the compose example).
    loadConfig(
      `${BASE.replace('"http://mini:8787/run"', '"http://openclaw:8787/run"')}${SAFE_POLICIES}`,
    );
  });

  it("agent ids that collide with Object.prototype cannot make unknown agents public", () => {
    const yaml = `${BASE}agents:\n  __proto__: { tier: public }\n${SAFE_POLICIES}`;
    const cfg = loadConfig(yaml);
    for (const a of ["unlisted", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(resolveTier(a, cfg), a).toBe("private");
    }
    // The same through a JSON-shaped object (JSON.parse creates an own "__proto__" key).
    const raw = JSON.parse(
      JSON.stringify({ ...loadConfig(`${BASE}${SAFE_POLICIES}`), agents: {} }).replace(
        '"agents":{}',
        '"agents":{"__proto__":{"tier":"public"}}',
      ),
    );
    const cfg2 = parseConfig(raw);
    expect(resolveTier("unlisted", cfg2)).toBe("private");
    const d = decide(
      {
        runId: "r",
        agentId: "unlisted",
        companyId: "c",
        tier: resolveTier("unlisted", cfg2),
        labels: [],
      },
      [node("mini", "offline")],
      cfg2,
    );
    expect(d.action).toBe("defer");
  });
});
