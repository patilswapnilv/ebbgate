/**
 * Privacy guarantee, concurrency: many requests in flight while presence and
 * the clock change underneath them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoPrivateLeak,
  type Harness,
  harness,
  postPresence,
  postRun,
  runPayload,
  UNKNOWN_AGENTS,
} from "./harness.js";

const AGENT_MIX = [
  "agent_inbox",
  "agent_finance",
  "agent_ops",
  "agent_research",
  ...UNKNOWN_AGENTS,
];

describe("privacy guarantee: concurrency", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    assertNoPrivateLeak(h);
    h.close();
  });

  it("400 concurrent runs while the Mac flaps and the clock moves", async () => {
    await postPresence(h, "mini");
    const work: Array<Promise<unknown>> = [];
    for (let i = 0; i < 400; i++) {
      const agent = AGENT_MIX[i % AGENT_MIX.length] as string;
      work.push(postRun(h, runPayload(`cc-${i}`, agent)));
      if (i % 37 === 0) {
        h.clock.now = new Date(h.clock.now.getTime() + 31_000);
        work.push(h.handle.tick());
      }
      if (i % 41 === 0) work.push(postPresence(h, i % 2 ? "mini" : "mbp", { mode: "busy" }));
      if (i % 53 === 0) work.push(postPresence(h, "mini"));
    }
    const results = await Promise.allSettled(work);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(h.net.toCloud().length).toBeGreaterThan(0); // the cloud path really was exercised
  });

  it("concurrent duplicates of the same private run id never reach the cloud", async () => {
    const res = await Promise.allSettled(
      Array.from({ length: 20 }, () => postRun(h, runPayload("dup-1", "agent_inbox"))),
    );
    expect(res.some((r) => r.status === "fulfilled")).toBe(true);
    expect(h.net.toCloud()).toHaveLength(0);
  });

  it("concurrent restarts-and-recoveries with in-flight private work", async () => {
    await postPresence(h, "mini");
    h.net.hold();
    const inflight = Array.from({ length: 10 }, (_, i) =>
      postRun(h, runPayload(`rr-${i}`, i % 2 ? "agent_inbox" : "agent_unlisted")),
    );
    await new Promise((r) => setTimeout(r, 20));
    h.clock.now = new Date(h.clock.now.getTime() + 31_000);
    const recoveries = [h.handle.tick(), h.handle.tick(), h.handle.presence.recoverInterrupted()];
    h.net.release();
    await Promise.allSettled([...inflight, ...recoveries]);
    expect(h.net.toCloud()).toHaveLength(0);
  });
});
