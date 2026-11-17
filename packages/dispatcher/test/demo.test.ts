import type { Decision, NodeStatus, TaskContext } from "@ebbgate/core";
import { describe, expect, it } from "vitest";
import { createDemoWriter, isDemoMode, logDemoDecision, logDemoPresence } from "../src/demo.js";

describe("EG_DEMO helpers", () => {
  it("detects EG_DEMO truthy values", () => {
    expect(isDemoMode({ EG_DEMO: "1" })).toBe(true);
    expect(isDemoMode({ EG_DEMO: "true" })).toBe(true);
    expect(isDemoMode({ EG_DEMO: "yes" })).toBe(true);
    expect(isDemoMode({ EG_DEMO: "0" })).toBe(false);
    expect(isDemoMode({})).toBe(false);
  });

  it("no-ops when disabled", () => {
    const lines: string[] = [];
    const write = createDemoWriter(false, (l) => lines.push(l));
    write("should not appear");
    expect(lines).toEqual([]);
  });

  it("formats a readable decision block", () => {
    const lines: string[] = [];
    const write = createDemoWriter(true, (l) => lines.push(l));
    const task: TaskContext = {
      runId: "run-1",
      agentId: "agent_inbox",
      companyId: "co",
      issueId: "issue-9",
      tier: "private",
      labels: ["local-files"],
    };
    const nodes: NodeStatus[] = [
      { node: "mini", state: "offline", lastSeenAt: null, report: null },
    ];
    const decision: Decision = {
      action: "defer",
      reason: "rule #1, tier=private, nodes=offline -> defer",
      notify: false,
      rule: 1,
    };
    logDemoDecision(write, { task, tier: "private", nodes, decision });
    const text = lines.join("\n");
    expect(text).toContain("ebbgate decision");
    expect(text).toContain("run     run-1");
    expect(text).toContain("agent   agent_inbox");
    expect(text).toContain("issue   issue-9");
    expect(text).toContain("tier    private");
    expect(text).toContain("labels=local-files");
    expect(text).toContain("mini=offline");
    expect(text).toContain("DEFER (wait for local)");
    expect(text).not.toContain("token");
    expect(text).not.toContain("secret");
  });

  it("logs presence transitions on one line", () => {
    const lines: string[] = [];
    const write = createDemoWriter(true, (l) => lines.push(l));
    logDemoPresence(write, { node: "mini", from: "available", to: "offline" });
    expect(lines).toEqual(["· presence  mini: available → offline"]);
  });
});
