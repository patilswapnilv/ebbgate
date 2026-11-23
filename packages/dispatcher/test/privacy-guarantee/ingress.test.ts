/**
 * Privacy guarantee, ingress (`POST /run`): who the task is, what it claims
 * about itself, and what is available must never move private work to the cloud.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENTS,
  assertNoPrivateLeak,
  type Harness,
  harness,
  postPresence,
  postRun,
  runPayload,
  SECRET,
  UNKNOWN_AGENTS,
} from "./harness.js";

const PRIVATE_AGENTS = Object.keys(AGENTS).filter((a) => AGENTS[a] === "private");

describe("privacy guarantee: ingress", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    assertNoPrivateLeak(h);
    h.close();
  });

  it("the cloud runner is the only reachable target: private and unknown agents defer, nothing is sent", async () => {
    // No node has ever sent a heartbeat, so every node is offline.
    let i = 0;
    for (const agent of [...PRIVATE_AGENTS, ...UNKNOWN_AGENTS]) {
      const res = await postRun(h, runPayload(`r-${i++}`, agent));
      expect(res.status, agent).toBe(202);
      expect(((await res.json()) as { action: string }).action).toBe("defer");
    }
    expect(h.net.toCloud()).toHaveLength(0);
    expect(h.net.toLocal()).toHaveLength(0);
    // Sanity check that the cloud path is live for explicitly public work.
    const pub = await postRun(h, runPayload("r-pub", "agent_research"));
    expect(pub.status).toBe(200);
    expect(h.net.toCloud()).toHaveLength(1);
  });

  it("unknown and near-miss agent ids are private even when every node is available", async () => {
    await postPresence(h, "mini");
    let i = 0;
    for (const agent of UNKNOWN_AGENTS) {
      const res = await postRun(h, runPayload(`u-${i++}`, agent));
      expect(res.status, agent).toBe(200);
    }
    expect(h.net.toCloud()).toHaveLength(0);
    expect(h.net.toLocal()).toHaveLength(UNKNOWN_AGENTS.length);
    const tiers = h.db.prepare(`SELECT DISTINCT tier FROM decisions`).all() as Array<{
      tier: string;
    }>;
    expect(tiers.map((t) => t.tier)).toEqual(["private"]);
  });

  it("a payload cannot set its own tier or privacy: extra fields are ignored", async () => {
    const spoofed = {
      ...runPayload("spoof-1", "agent_inbox", {
        tier: "public",
        private: false,
        labels: ["public", "cloud", "tier:public"],
      }),
      tier: "public",
      privacy: "public",
      target: "cloud",
    };
    const res = await postRun(h, spoofed);
    expect(res.status).toBe(202);
    expect(h.net.toCloud()).toHaveLength(0);
  });

  it("any label set on a private task still defers when offline", async () => {
    const labelSets = [
      [],
      ["local-files"],
      ["public"],
      ["cloud", "urgent"],
      ["", " ", "\u0000"],
      Array.from({ length: 200 }, (_, k) => `l${k}`),
    ];
    let i = 0;
    for (const labels of labelSets) {
      const res = await postRun(h, runPayload(`lab-${i++}`, "agent_finance", { labels }));
      expect(res.status).toBe(202);
    }
    expect(h.net.toCloud()).toHaveLength(0);
  });

  it("missing or null labels on a private task fail closed", async () => {
    const a = runPayload("nolabels-1", "agent_inbox");
    delete (a.context as Record<string, unknown>).labels;
    const b = runPayload("nolabels-2", "agent_inbox", { labels: null });
    const c = { runId: "nolabels-3", agentId: "agent_inbox" }; // no context at all
    const d = { runId: "nolabels-4", agentId: "agent_inbox", context: "not-an-object" };
    for (const body of [a, b, c, d]) expect((await postRun(h, body)).status).toBe(202);
    expect(h.net.toCloud()).toHaveLength(0);
  });

  it("malformed payloads are rejected before any routing", async () => {
    const bad: unknown[] = [
      "{not json",
      "null",
      "[]",
      "42",
      { agentId: "agent_research" }, // no runId
      { runId: "m-1" }, // no agentId: unknown, but also unroutable
      { runId: "m-2", agentId: "" },
      { runId: "m-3", agentId: 7 },
      { runId: "m-4", agentId: ["agent_research"] },
      { runId: "m-5", agentId: { toString: "agent_research" } },
      runPayload("m-6", "agent_research", { labels: "local-files" }),
      runPayload("m-7", "agent_research", { labels: [1, 2] }),
      runPayload("m-8", "agent_research", { labels: [null] }),
      runPayload("m-9", "agent_research", { companyId: 5 }),
    ];
    for (const body of bad) {
      const res = await postRun(h, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.net.sent).toHaveLength(0);
  });

  it("an unauthenticated caller cannot get anything routed", async () => {
    const res = await h.handle.app.request("/run", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret-0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify(runPayload("unauth", "agent_research")),
    });
    expect(res.status).toBe(401);
    expect(h.net.sent).toHaveLength(0);
  });

  it("a busy Mac never pushes private work to the cloud", async () => {
    await postPresence(h, "mini", { mode: "busy" });
    await postPresence(h, "mbp", { onBattery: true });
    expect((await postRun(h, runPayload("busy-1", "agent_inbox"))).status).toBe(200);
    expect(h.net.toCloud()).toHaveLength(0);
    expect(h.net.toLocal()).toHaveLength(1);
  });

  it("a failing local runner surfaces an error; it does not fall back to the cloud", async () => {
    await postPresence(h, "mini");
    h.net.failFor(["http://mini.invalid:8787/run"]);
    const res = await postRun(h, runPayload("fail-1", "agent_inbox"));
    expect(res.status).toBe(502);
    expect(h.net.toCloud()).toHaveLength(0);
  });
});

describe("privacy guarantee: credentials", () => {
  it("FIXED: the cloud runner never receives the dispatcher's shared secret", async () => {
    const h = harness();
    try {
      expect((await postRun(h, runPayload("cred-1", "agent_research"))).status).toBe(200);
      const [hit] = h.net.toCloud();
      expect(hit).toBeDefined();
      expect(hit?.headers.authorization).toBeUndefined();
      // Local runners on your own machines still get it (they forward to the local gateway).
      await postPresence(h, "mini");
      expect((await postRun(h, runPayload("cred-2", "agent_inbox"))).status).toBe(200);
      expect(h.net.toLocal()[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    } finally {
      h.close();
    }
  });
});
