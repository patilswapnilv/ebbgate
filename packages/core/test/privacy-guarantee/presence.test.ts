/** Privacy guarantee, presence derivation: stale, missing and skewed heartbeats. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveState } from "../../src/policy.js";
import type { PresenceReport } from "../../src/types.js";

const now = new Date("2026-11-23T10:00:00.000Z");
const report: PresenceReport = {
  node: "mini",
  mode: "auto",
  freeRamGb: 16,
  onBattery: false,
  userIdleSeconds: 5,
  modelsLoaded: [],
  modelsInstalled: [],
  agentVersion: "t",
  sentAt: now.toISOString(),
};

describe("privacy guarantee: presence derivation", () => {
  it("missing report or timestamp is offline", () => {
    expect(deriveState(null, now.toISOString(), now, 90)).toBe("offline");
    expect(deriveState(report, null, now, 90)).toBe("offline");
    expect(deriveState(report, "", now, 90)).toBe("offline");
    expect(deriveState(report, "garbage", now, 90)).toBe("offline");
  });

  it("FIXED: a heartbeat stamped beyond the window in the future is offline (clock skew)", () => {
    const future = new Date(now.getTime() + 91_000).toISOString();
    expect(deriveState(report, future, now, 90)).toBe("offline");
    const slightlyAhead = new Date(now.getTime() + 5_000).toISOString();
    expect(deriveState(report, slightlyAhead, now, 90)).toBe("available");
  });

  it("property: a node is only ever non-offline within the freshness window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10 * 86_400_000, max: 10 * 86_400_000 }),
        fc.integer({ min: 10, max: 3600 }),
        fc.constantFrom("auto", "busy", "available" as const),
        fc.boolean(),
        (offsetMs, windowS, mode, onBattery) => {
          const seen = new Date(now.getTime() - offsetMs).toISOString();
          const st = deriveState({ ...report, mode, onBattery }, seen, now, windowS);
          if (Math.abs(offsetMs) > windowS * 1000) expect(st).toBe("offline");
        },
      ),
      { numRuns: 2000 },
    );
  });
});
