import { describe, expect, it } from "vitest";
import { decide, resolveTier } from "../src/policy.js";
import type { NodeStatus, PresenceState } from "../src/types.js";
import { exampleConfig, node, task } from "./helpers.js";

const config = exampleConfig();

/** One local node ("mini") in the given state. */
function oneNode(state: PresenceState): NodeStatus[] {
  return [node("mini", state)];
}

type Expected = "local" | "local-low" | "cloud" | "defer";

/** The policy matrix from BUILD_SPEC.md §10. */
const MATRIX: Array<{
  name: string;
  agentId: string;
  labels?: string[];
  expect: Record<PresenceState, Expected>;
}> = [
  {
    name: "private",
    agentId: "agent_inbox",
    expect: { available: "local", busy: "local-low", offline: "defer" },
  },
  {
    name: "internal",
    agentId: "agent_ops",
    expect: { available: "local", busy: "cloud", offline: "cloud" },
  },
  {
    name: "public",
    agentId: "agent_research",
    expect: { available: "cloud", busy: "cloud", offline: "cloud" },
  },
  {
    name: "label local-files (public agent)",
    agentId: "agent_research",
    labels: ["local-files"],
    expect: { available: "local", busy: "local-low", offline: "defer" },
  },
  {
    name: "unknown agent (treated as private)",
    agentId: "agent_never_configured",
    expect: { available: "local", busy: "local-low", offline: "defer" },
  },
];

describe("policy matrix (BUILD_SPEC §10)", () => {
  for (const row of MATRIX) {
    for (const state of ["available", "busy", "offline"] as const) {
      it(`${row.name} / node ${state} -> ${row.expect[state]}`, () => {
        const d = decide(task(row.agentId, config, row.labels), oneNode(state), config);
        const expected = row.expect[state];

        if (expected === "local" || expected === "local-low") {
          expect(d.action).toBe("local");
          if (d.action === "local") {
            expect(d.node).toBe("mini");
            expect(d.priority).toBe(expected === "local" ? "normal" : "low");
          }
        } else {
          expect(d.action).toBe(expected);
        }
        expect(d.reason.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("tier resolution", () => {
  it("uses the configured tier", () => {
    expect(resolveTier("agent_ops", config)).toBe("internal");
  });

  it("treats unknown agents as private (fail closed)", () => {
    expect(resolveTier("who_is_this", config)).toBe("private");
  });
});

describe("node selection", () => {
  it("prefers a node marked prefer: true when it is available", () => {
    const d = decide(
      task("agent_inbox", config),
      [node("mini", "available", 30), node("mbp", "available", 4)],
      config,
    );
    expect(d).toMatchObject({ action: "local", node: "mbp" });
  });

  it("uses another available node when the preferred one is offline", () => {
    const d = decide(
      task("agent_inbox", config),
      [node("mini", "available"), node("mbp", "offline")],
      config,
    );
    expect(d).toMatchObject({ action: "local", node: "mini", priority: "normal" });
  });

  it("among equal preference, picks the node with more free RAM", () => {
    const cfg = {
      ...config,
      nodes: {
        a: { runner: "http://a:8787", token: "x".repeat(16), prefer: false },
        b: { runner: "http://b:8787", token: "y".repeat(16), prefer: false },
      },
    };
    const d = decide(
      task("agent_inbox", cfg),
      [node("a", "available", 4), node("b", "available", 12)],
      cfg,
    );
    expect(d).toMatchObject({ action: "local", node: "b" });
  });

  it("local-low accepts a busy node when none is available", () => {
    const d = decide(
      task("agent_inbox", config),
      [node("mini", "busy"), node("mbp", "offline")],
      config,
    );
    expect(d).toMatchObject({ action: "local", node: "mini", priority: "low" });
  });

  it("ignores nodes that are not in the config", () => {
    const d = decide(task("agent_inbox", config), [node("stranger", "available")], config);
    expect(d.action).toBe("defer");
  });

  it("defers with notify on the local-files rule when nothing is reachable", () => {
    const d = decide(
      task("agent_ops", config, ["local-files"]),
      [node("mini", "offline"), node("mbp", "offline")],
      config,
    );
    expect(d).toMatchObject({ action: "defer", notify: true, rule: 0 });
  });

  it("is deterministic for the same input", () => {
    const nodes = [node("mini", "available", 8), node("mbp", "busy", 8)];
    const a = decide(task("agent_ops", config), nodes, config);
    const b = decide(task("agent_ops", config), nodes, config);
    expect(a).toEqual(b);
  });
});
