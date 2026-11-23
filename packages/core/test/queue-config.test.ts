import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { exampleConfig } from "./helpers.js";

function withOverrides(extra: Record<string, unknown>) {
  const { queue: _q, ...base } = exampleConfig();
  return parseConfig({ ...base, ...extra });
}

describe("queue durability config", () => {
  it("defaults the queue section", () => {
    expect(withOverrides({}).queue).toEqual({
      maxAttempts: 10,
      retryBaseSeconds: 5,
      retryMaxSeconds: 900,
      leaseSeconds: 300,
      shutdownGraceSeconds: 10,
    });
  });

  it("accepts an optional per-agent defer TTL and rejects nonsense", () => {
    const cfg = withOverrides({ agents: { a: { tier: "private", deferTtlHours: 4 } } });
    expect(cfg.agents.a?.deferTtlHours).toBe(4);
    expect(() => withOverrides({ agents: { a: { tier: "private", deferTtlHours: 0 } } })).toThrow(
      ConfigError,
    );
    expect(() => withOverrides({ queue: { maxAttempts: 0 } })).toThrow(ConfigError);
    expect(() => withOverrides({ queue: { leaseSeconds: 1 } })).toThrow(ConfigError);
  });
});
