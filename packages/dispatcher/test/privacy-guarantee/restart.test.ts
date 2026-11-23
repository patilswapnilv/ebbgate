/**
 * Privacy guarantee, crashes and restarts: a dispatcher that dies between
 * deciding and dispatching, mid-forward, or with a corrupted database must come
 * back without sending private work to the cloud.
 */

import { parseConfig } from "@ebbgate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRunning, recordDecision } from "../../src/services/runs.js";
import {
  assertNoPrivateLeak,
  config,
  type Harness,
  harness,
  MINI_RUNNER,
  postPresence,
  postRun,
  rawConfig,
  runPayload,
} from "./harness.js";

function deferredRows(h: Harness) {
  return h.db.prepare(`SELECT run_id, tier, status FROM deferred`).all() as Array<{
    run_id: string;
    tier: string;
    status: string;
  }>;
}

/** Leave rows exactly as a crash between decide() and the forward would. */
function crashAfterDecide(
  h: Harness,
  runId: string,
  agentId: string,
  opts: { dispatched: boolean; payload?: unknown; payloadJson?: string },
) {
  const at = h.clock.now.toISOString();
  recordDecision(h.db, {
    runId,
    agentId,
    tier: "private",
    decision: { action: "local", node: "mini", priority: "normal", reason: "test", rule: 1 },
    decidedAt: at,
  });
  insertRunning(h.db, {
    runId: `${runId}:local`,
    agentId,
    companyId: "company-test",
    target: "local",
    nodeId: "mini",
    priority: "normal",
    startedAt: at,
    payload: opts.payload ?? runPayload(runId, agentId),
    origin: "replacement",
  });
  if (opts.payloadJson !== undefined) {
    h.db
      .prepare(`UPDATE runs SET payload_json = ? WHERE run_id = ?`)
      .run(opts.payloadJson, `${runId}:local`);
  }
  if (opts.dispatched) {
    h.db.prepare(`UPDATE runs SET dispatched_at = ? WHERE run_id = ?`).run(at, `${runId}:local`);
  }
}

describe("privacy guarantee: crashes and restarts", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    assertNoPrivateLeak(h);
    h.close();
  });

  it("crash between decide and dispatch (never sent): restart with the Mac offline defers, no cloud", async () => {
    crashAfterDecide(h, "c-1", "agent_inbox", { dispatched: false });
    crashAfterDecide(h, "c-2", "agent_unlisted", { dispatched: false });
    const handle = h.restart();
    const report = await handle.presence.reconcileAfterRestart();
    expect(report.neverDispatched.sort()).toEqual(["c-1:local", "c-2:local"]);
    expect(h.net.sent).toHaveLength(0);
    expect(deferredRows(h).map((r) => r.tier)).toEqual(["private", "private"]);
  });

  it("crash after dispatch (outcome unknown): replay stays local or waits, never cloud", async () => {
    crashAfterDecide(h, "c-3", "agent_finance", { dispatched: true });
    await h.restart().presence.reconcileAfterRestart();
    expect(h.net.toCloud()).toHaveLength(0);
    expect(deferredRows(h)).toHaveLength(1);
  });

  it("crash mid-forward on ingress: restart marks it failed and does not re-route it anywhere", async () => {
    await postPresence(h, "mini");
    h.net.hold();
    const pending = postRun(h, runPayload("mid-1", "agent_inbox"));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.net.toLocal()).toHaveLength(1);
    // The process dies here. The in-flight promise is abandoned.
    h.clock.now = new Date(h.clock.now.getTime() + 60 * 60_000); // Mac gone too
    const handle = h.restart();
    const report = await handle.presence.reconcileAfterRestart();
    expect(report.failedIngress).toEqual(["mid-1"]);
    h.net.release();
    await pending.catch(() => {});
    expect(h.net.toCloud()).toHaveLength(0);
  });

  it("node drops mid-forward: the interrupted private run is re-deferred, not re-sent to the cloud", async () => {
    await postPresence(h, "mini");
    h.net.hold();
    const pending = postRun(h, runPayload("drop-1", "agent_inbox"));
    await new Promise((r) => setTimeout(r, 10));
    h.clock.now = new Date(h.clock.now.getTime() + 31_000);
    await h.handle.tick(); // mini goes offline; recovery re-decides
    h.net.release();
    await pending;
    expect(h.net.toCloud()).toHaveLength(0);
    expect(deferredRows(h).map((r) => r.run_id)).toEqual(["drop-1:redecide"]);
  });

  it("node drops mid-forward for an internal task: recovery may use the cloud (sanity check)", async () => {
    await postPresence(h, "mini");
    const cfg = config({
      policies: [
        { match: { tier: "private" }, available: "local", busy: "local-low", offline: "defer" },
        { match: { tier: "internal" }, available: "local", busy: "cloud", offline: "cloud" },
        { default: { available: "cloud", busy: "cloud", offline: "cloud" } },
      ],
    });
    h.restart(cfg);
    await postPresence(h, "mini");
    h.net.hold();
    const pending = postRun(h, runPayload("drop-2", "agent_ops"));
    await new Promise((r) => setTimeout(r, 10));
    h.clock.now = new Date(h.clock.now.getTime() + 31_000);
    const ticking = h.handle.tick();
    await new Promise((r) => setTimeout(r, 10));
    h.net.release();
    await ticking;
    await pending;
    expect(h.net.toCloud().map((s) => (s.body as { runId: string }).runId)).toEqual(["drop-2"]);
  });

  it("a corrupted stored payload is never replayed to the cloud", async () => {
    crashAfterDecide(h, "c-4", "agent_research", { dispatched: false, payloadJson: "{broken" });
    // Re-parse failure: an otherwise public agent is treated as private.
    crashAfterDecide(h, "c-5", "agent_research", {
      dispatched: false,
      payload: { runId: "c-5", agentId: "agent_research", context: { labels: "not-an-array" } },
    });
    await h.restart().presence.reconcileAfterRestart();
    expect(h.net.toCloud()).toHaveLength(0);
    expect(deferredRows(h).map((r) => [r.run_id, r.tier])).toEqual([
      ["c-5:local:redecide", "private"],
    ]);
  });

  it("an agent removed from the config across a restart becomes private", async () => {
    crashAfterDecide(h, "c-6", "agent_research", { dispatched: false });
    const raw = rawConfig();
    const agents = { ...(raw.agents as Record<string, unknown>) };
    delete agents.agent_research;
    const handle = h.restart(parseConfig({ ...raw, agents }));
    await handle.presence.reconcileAfterRestart();
    expect(h.net.toCloud()).toHaveLength(0);
    expect(deferredRows(h).map((r) => r.tier)).toEqual(["private"]);
  });

  it("repeated crash loops never accumulate a cloud dispatch for private work", async () => {
    crashAfterDecide(h, "loop-1", "agent_inbox", { dispatched: true });
    for (let i = 0; i < 5; i++) {
      await h.restart().presence.reconcileAfterRestart();
      await h.handle.tick();
    }
    expect(h.net.toCloud()).toHaveLength(0);
    // Mac returns: the deferred work is woken via Paperclip, not pushed to a runner.
    await postPresence(h, "mini");
    expect(h.net.sent.filter((s) => s.url === MINI_RUNNER)).toHaveLength(0);
    expect(h.paperclip.wakes.length).toBeGreaterThan(0);
  });
});
