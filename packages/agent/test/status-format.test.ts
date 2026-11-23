import { describe, expect, it } from "vitest";
import { formatAge, formatDispatcherStatus, formatWhy } from "../src/status-format.js";

const now = new Date("2026-11-23T12:00:00.000Z");

describe("status formatting", () => {
  it("formats ages", () => {
    expect(formatAge("2026-11-23T11:59:30.000Z", now)).toBe("30s");
    expect(formatAge("2026-11-23T11:45:00.000Z", now)).toBe("15m");
    expect(formatAge("2026-11-23T09:30:00.000Z", now)).toBe("2h 30m");
    expect(formatAge("2026-11-20T11:00:00.000Z", now)).toBe("3d 1h");
    expect(formatAge("not a date", now)).toBe("?");
    expect(formatAge(undefined, now)).toBe("?");
  });

  it("renders a full status", () => {
    const lines = formatDispatcherStatus(
      {
        presence: {
          overall: "busy",
          nodes: [
            { node: "mini", state: "busy", lastSeenAt: "2026-11-23T11:59:00.000Z" },
            { node: "mbp", state: "offline", lastSeenAt: null },
          ],
        },
        queue: { pending: 2, waking: 0, done: 4, expired: 1, held: 2 },
        waiting: [
          {
            taskId: "run-1",
            agentId: "agent_inbox",
            tier: "private",
            since: "2026-11-23T11:00:00.000Z",
            code: "HELD_PRIVATE_MAC_BUSY",
            text: "held because it's private and your Mac is busy",
          },
        ],
        topReason: { code: "HELD_PRIVATE_MAC_BUSY", text: "held …", count: 2 },
      },
      now,
    );
    expect(lines).toEqual([
      "presence: ◐ busy",
      "  ◐ mini: busy (last seen 1m ago)",
      "  ○ mbp: offline (never seen)",
      "queue: 2 held (2 pending, 0 waking), 4 done, 1 expired",
      "waiting:",
      "  run-1  agent_inbox  private  1h 0m  HELD_PRIVATE_MAC_BUSY: held because it's private and your Mac is busy",
      "  … and 1 more",
      "top reason: HELD_PRIVATE_MAC_BUSY (2): held …",
    ]);
  });

  it("survives a v0.1 or malformed answer", () => {
    expect(
      formatDispatcherStatus({ nodes: [{ node: "mini", state: "available" }], queueDepth: 0 }),
    ).toContain("waiting: nothing is waiting at the gate");
    expect(() => formatDispatcherStatus(null)).not.toThrow();
    expect(() => formatDispatcherStatus({ presence: 3, waiting: "x", queue: [] })).not.toThrow();
    expect(formatWhy("x", { decisions: "nope" })).toEqual([
      "x: no decisions recorded (unknown task, or older than the audit retention)",
    ]);
  });

  it("explains a finished task from its latest decision", () => {
    const lines = formatWhy(
      "run-9",
      {
        decisions: [
          {
            kind: "route",
            taskId: "run-9",
            agentId: "agent_ops",
            decision: "cloud",
            target: "cloud",
            tier: "internal",
            code: "RUN_CLOUD_MAC_OFFLINE",
            text: "sent to the cloud because your Mac is offline (rule #2)",
            rule: "2",
            presence: "offline",
            decidedAt: "2026-11-23T11:00:00.000Z",
          },
        ],
        waiting: null,
      },
      now,
    );
    expect(lines[0]).toBe(
      "run-9: cloud -> cloud, RUN_CLOUD_MAC_OFFLINE: sent to the cloud because your Mac is offline (rule #2)",
    );
    expect(lines[2]).toContain("[internal, offline, rule 2]");
  });
});
