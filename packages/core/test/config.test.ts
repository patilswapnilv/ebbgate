import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { deriveState } from "../src/policy.js";
import { EXAMPLE_YAML, exampleConfig, report, TEST_ENV } from "./helpers.js";

function baseRaw(policies: unknown) {
  return {
    server: { publicUrl: "http://cloud:8790" },
    nodes: { mini: { runner: "http://mini:8787", token: "t".repeat(16) } },
    cloud: { runner: "http://openclaw:18789/paperclip" },
    paperclip: { apiUrl: "http://paperclip:3100", apiKey: "k", sharedSecret: "s".repeat(16) },
    policies,
  };
}

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

const privateLocal = {
  match: { tier: "private" },
  available: "local",
  busy: "local-low",
  offline: "defer",
};
const defaultCloud = { default: { available: "cloud", busy: "cloud", offline: "cloud" } };

describe("loading the example config", () => {
  it("accepts ebbgate.example.yaml", () => {
    const config = exampleConfig();
    expect(Object.keys(config.nodes)).toEqual(["mini", "mbp"]);
    expect(config.policies).toHaveLength(4);
    expect(config.presence.offlineAfterSeconds).toBe(90);
  });

  it("interpolates env vars into string values", () => {
    expect(exampleConfig().nodes.mini?.token).toBe(TEST_ENV.EG_NODE_MINI_TOKEN);
  });

  it("reports every missing env var at once, with paths", () => {
    const issues = issuesOf(() => loadConfig(EXAMPLE_YAML, {}));
    expect(issues.length).toBeGreaterThanOrEqual(5);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/EG_NODE_MINI_TOKEN/);
    expect(issues.some((i) => i.path === "nodes.mini.token")).toBe(true);
  });

  it("applies defaults", () => {
    const config = parseConfig(baseRaw([privateLocal, defaultCloud]));
    expect(config.server.port).toBe(8790);
    expect(config.agents).toEqual({});
    expect(config.presence).toEqual({
      offlineAfterSeconds: 90,
      drainConcurrency: 2,
      deferredMaxAgeHours: 72,
    });
  });

  it("returns a readable error for invalid YAML", () => {
    const issues = issuesOf(() => loadConfig("nodes: [unclosed", {}));
    expect(issues[0]?.message).toMatch(/YAML parse error/);
  });
});

describe("privacy validation", () => {
  it("rejects a private rule that uses cloud", () => {
    const issues = issuesOf(() =>
      parseConfig(baseRaw([{ ...privateLocal, offline: "cloud" }, defaultCloud])),
    );
    expect(issues).toContainEqual(expect.objectContaining({ path: "policies.0.offline" }));
  });

  it("rejects a cloud default when no earlier rule captures private tasks", () => {
    const issues = issuesOf(() =>
      parseConfig(
        baseRaw([
          { match: { tier: "internal" }, available: "local", busy: "cloud", offline: "cloud" },
          defaultCloud,
        ]),
      ),
    );
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["policies.1.default.available", "policies.1.default.offline"]),
    );
  });

  it("rejects a label-only rule with cloud placed before the private rule", () => {
    const issues = issuesOf(() =>
      parseConfig(
        baseRaw([
          { match: { label: "urgent" }, available: "cloud", busy: "cloud", offline: "cloud" },
          privateLocal,
          defaultCloud,
        ]),
      ),
    );
    expect(issues.some((i) => i.path.startsWith("policies.0"))).toBe(true);
  });

  it("allows a label-only cloud rule after private tasks are captured", () => {
    expect(() =>
      parseConfig(
        baseRaw([
          privateLocal,
          { match: { label: "urgent" }, available: "cloud", busy: "cloud", offline: "cloud" },
          defaultCloud,
        ]),
      ),
    ).not.toThrow();
  });

  it("does not treat a private+label rule as capturing all private tasks", () => {
    const issues = issuesOf(() =>
      parseConfig(
        baseRaw([
          {
            match: { tier: "private", label: "local-files" },
            available: "local",
            busy: "local-low",
            offline: "defer",
          },
          defaultCloud,
        ]),
      ),
    );
    expect(issues.some((i) => i.path.startsWith("policies.1.default"))).toBe(true);
  });
});

describe("structural validation", () => {
  it("requires a default rule", () => {
    const issues = issuesOf(() => parseConfig(baseRaw([privateLocal])));
    expect(issues[0]?.message).toMatch(/default/);
  });

  it("requires the default rule to be last", () => {
    const issues = issuesOf(() => parseConfig(baseRaw([defaultCloud, privateLocal])));
    expect(issues.some((i) => /must be the last rule/.test(i.message))).toBe(true);
  });

  it("rejects a local action for the offline state", () => {
    const issues = issuesOf(() =>
      parseConfig(baseRaw([{ ...privateLocal, offline: "local" }, defaultCloud])),
    );
    expect(issues.some((i) => i.path === "policies.0.offline" || i.path === "policies.0")).toBe(
      true,
    );
  });

  it("rejects a match with neither tier nor label", () => {
    expect(() =>
      parseConfig(
        baseRaw([{ match: {}, available: "local", busy: "local", offline: "defer" }, defaultCloud]),
      ),
    ).toThrow(ConfigError);
  });

  it("rejects unknown keys (typos)", () => {
    expect(() => parseConfig({ ...baseRaw([privateLocal, defaultCloud]), nodez: {} })).toThrow(
      ConfigError,
    );
  });

  it("rejects short tokens", () => {
    const raw = baseRaw([privateLocal, defaultCloud]);
    raw.nodes.mini.token = "short";
    expect(() => parseConfig(raw)).toThrow(/at least 16 characters/);
  });

  it("never echoes secret values in error messages", () => {
    const raw = baseRaw([{ ...privateLocal, offline: "cloud" }, defaultCloud]);
    try {
      parseConfig(raw);
    } catch (err) {
      expect((err as Error).message).not.toContain("t".repeat(16));
      expect((err as Error).message).not.toContain("s".repeat(16));
    }
  });
});

describe("deriveState", () => {
  const now = new Date("2026-11-16T10:01:00.000Z");
  const seen = "2026-11-16T10:00:30.000Z"; // 30 s ago

  it("is offline with no report", () => {
    expect(deriveState(null, null, now, 90)).toBe("offline");
  });

  it("is offline once the report is older than the threshold", () => {
    expect(deriveState(report("mini"), "2026-11-16T09:59:00.000Z", now, 90)).toBe("offline");
  });

  it("is available in auto mode on mains power", () => {
    expect(deriveState(report("mini"), seen, now, 90)).toBe("available");
  });

  it("is busy in auto mode on battery", () => {
    expect(deriveState(report("mini", { onBattery: true }), seen, now, 90)).toBe("busy");
  });

  it("respects a manual busy override", () => {
    expect(deriveState(report("mini", { mode: "busy" }), seen, now, 90)).toBe("busy");
  });

  it("respects a manual available override even on battery", () => {
    expect(deriveState(report("mini", { mode: "available", onBattery: true }), seen, now, 90)).toBe(
      "available",
    );
  });
});
