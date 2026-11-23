import { describe, expect, it } from "vitest";
import { runDemo } from "../src/demo-scenario.js";

describe("ebbgate demo scenario", () => {
  it("routes local, then cloud for non-private, defers private while offline and drains on return", async () => {
    const lines: string[] = [];
    const result = await runDemo({ write: (l) => lines.push(l), stepDelayMs: 0 });
    const text = lines.join("\n");

    expect(result.dispatched).toEqual([
      { runId: "run-101", target: "local" },
      { runId: "run-102", target: "cloud" },
      { runId: "run-103-resume-1", target: "local" },
    ]);
    expect(result.deferred).toEqual(["run-103"]);
    expect(result.wakes).toEqual([{ agentId: "agent_inbox", issueId: "ISS-3" }]);
    expect(result.pendingAtEnd).toBe(0);
    expect(result.privateToCloud).toBe(0);

    // Private work never reaches the cloud runner.
    for (const d of result.dispatched) {
      if (d.runId.startsWith("run-101") || d.runId.startsWith("run-103")) {
        expect(d.target).toBe("local");
      }
    }

    // EG_DEMO decision blocks and presence transitions are printed.
    expect(text.match(/ebbgate decision/g)?.length).toBe(4);
    expect(text).toContain("LOCAL → mini");
    expect(text).toContain("action  CLOUD");
    expect(text).toContain("DEFER (wait for local)");
    expect(text).toContain("· presence  mini: offline → available");
    expect(text).toContain("· presence  mini: available → offline");
    // No demo credentials are printed.
    expect(text).not.toMatch(/not-real|Bearer/);
  });

  it("finishes well under 60 seconds with the default pacing budget", async () => {
    const result = await runDemo({ write: () => {}, stepDelayMs: 0 });
    expect(result.elapsedMs).toBeLessThan(5_000);
  });

  it("can run twice in one process (no shared state)", async () => {
    const a = await runDemo({ write: () => {} });
    const b = await runDemo({ write: () => {} });
    expect(b.dispatched).toEqual(a.dispatched);
  });
});
