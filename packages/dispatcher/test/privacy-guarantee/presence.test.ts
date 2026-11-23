/**
 * Privacy guarantee, presence: stale, missing, future-dated and flapping
 * heartbeats change where private work runs locally or whether it waits,
 * never whether it reaches the cloud.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoPrivateLeak,
  type Harness,
  harness,
  postPresence,
  postRun,
  runPayload,
} from "./harness.js";

describe("privacy guarantee: presence", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    assertNoPrivateLeak(h);
    h.close();
  });

  it("a stale heartbeat makes the node offline; private work defers", async () => {
    await postPresence(h, "mini");
    h.clock.now = new Date(h.clock.now.getTime() + 31_000); // past offlineAfterSeconds (30)
    const res = await postRun(h, runPayload("stale-1", "agent_inbox"));
    expect(res.status).toBe(202);
    expect(h.net.sent).toHaveLength(0);
  });

  it("a stale heartbeat is offline even before any tick has updated the stored state", async () => {
    await postPresence(h, "mini");
    h.clock.now = new Date(h.clock.now.getTime() + 10 * 60_000);
    // The `nodes.state` column still says available; routing must not trust it.
    const row = h.db.prepare(`SELECT state FROM nodes WHERE id = 'mini'`).get() as {
      state: string;
    };
    expect(row.state).toBe("available");
    expect((await postRun(h, runPayload("stale-2", "agent_finance"))).status).toBe(202);
    expect(h.net.sent).toHaveLength(0);
  });

  it("clock skew: a heartbeat dated far in the future does not keep a node alive forever", async () => {
    await postPresence(h, "mini");
    // The dispatcher's clock jumps back an hour (NTP correction, VM restore).
    h.clock.now = new Date(h.clock.now.getTime() - 60 * 60_000);
    const statuses = h.handle.presence.listNodeStatuses();
    expect(statuses.find((s) => s.node === "mini")?.state).toBe("offline");
    expect((await postRun(h, runPayload("skew-1", "agent_inbox"))).status).toBe(202);
    expect(h.net.toCloud()).toHaveLength(0);
  });

  it("clock skew: the agent's own sentAt is ignored, so a skewed Mac clock changes nothing", async () => {
    await postPresence(h, "mini", { sentAt: "1999-01-01T00:00:00.000Z" });
    expect((await postRun(h, runPayload("skew-2", "agent_inbox"))).status).toBe(200);
    await postPresence(h, "mini", { sentAt: "2999-01-01T00:00:00.000Z" });
    expect((await postRun(h, runPayload("skew-3", "agent_inbox"))).status).toBe(200);
    expect(h.net.toLocal()).toHaveLength(2);
  });

  it("a tampered heartbeat row (garbage timestamp) reads as offline", async () => {
    await postPresence(h, "mini");
    h.db.prepare(`UPDATE nodes SET last_seen_at = 'not-a-date' WHERE id = 'mini'`).run();
    expect((await postRun(h, runPayload("tamper-1", "agent_inbox"))).status).toBe(202);
    expect(h.net.sent).toHaveLength(0);
  });

  it("presence from an unknown node or with a bad token changes nothing", async () => {
    const unknown = await h.handle.app.request("/presence", {
      method: "POST",
      headers: {
        authorization: "Bearer whatever-0123456789abcdef",
        "content-type": "application/json",
      },
      body: JSON.stringify({ node: "evil" }),
    });
    expect(unknown.status).toBe(404);
    const proto = await h.handle.app.request("/presence", {
      method: "POST",
      headers: {
        authorization: "Bearer whatever-0123456789abcdef",
        "content-type": "application/json",
      },
      body: JSON.stringify({ node: "constructor" }),
    });
    expect(proto.status).toBe(404);
    expect(h.handle.presence.listNodeStatuses().every((s) => s.state === "offline")).toBe(true);
  });

  it("flapping presence: every interleaving of up/down/busy keeps private work off the cloud", async () => {
    const steps = 300;
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < steps; i++) {
      const r = rand();
      if (r < 0.25) await postPresence(h, "mini", { mode: rand() < 0.5 ? "busy" : "auto" });
      else if (r < 0.35) await postPresence(h, "mbp", { onBattery: rand() < 0.5 });
      else if (r < 0.5) {
        h.clock.now = new Date(h.clock.now.getTime() + Math.floor(rand() * 60_000));
        await h.handle.tick();
      } else {
        const agent = [
          "agent_inbox",
          "agent_finance",
          "agent_unlisted",
          "agent_ops",
          "agent_research",
        ][Math.floor(rand() * 5)] as string;
        await postRun(h, runPayload(`flap-${i}`, agent));
      }
    }
    // Something must actually have gone to the cloud, or the test proves nothing.
    expect(h.net.toCloud().length).toBeGreaterThan(0);
  });
});
