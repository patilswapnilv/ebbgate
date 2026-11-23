import { type EbbgateConfig, parseConfig, resolveTier } from "@ebbgate/core";
import { createApp } from "./app.js";
import { openDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { parseRun } from "./paperclip/parse.js";
import type { PaperclipClient, TaskContextInput } from "./paperclip/types.js";
import type { Notifier } from "./services/notifier.js";

/**
 * `ebbgate demo`: the real dispatcher (policy engine, SQLite deferred queue,
 * presence service) running in-process against a fake Paperclip and fake
 * runners. No network listeners, no Docker, no API keys, no files written.
 */

const LOCAL_RUNNER = "http://mini.demo.invalid/run";
const CLOUD_RUNNER = "http://cloud.demo.invalid/run";
// Demo-only placeholders, never used outside this process.
const DEMO_SECRET = "demo-shared-secret-not-real-0001";
const DEMO_NODE_TOKEN = "demo-node-token-not-real-00001";

export interface DemoOptions {
  /** Where output goes. Defaults to stdout. */
  write?: (line: string) => void;
  /** Pause between steps, in ms, so a screen recording can follow. 0 in tests. */
  stepDelayMs?: number;
}

export interface DemoResult {
  /** Runner each run id finally reached ("local" | "cloud"). */
  dispatched: Array<{ runId: string; target: "local" | "cloud" }>;
  /** Run ids that were deferred. */
  deferred: string[];
  /** Agent wakes Paperclip received when the queue drained. */
  wakes: Array<{ agentId: string; issueId?: string }>;
  /** Private-tier runs that reached the cloud runner (must be 0). */
  privateToCloud: number;
  /** Pending deferred rows left at the end (should be 0). */
  pendingAtEnd: number;
  elapsedMs: number;
}

export function demoConfig(): EbbgateConfig {
  return parseConfig(
    {
      server: { port: 8790, publicUrl: "http://127.0.0.1:8790" },
      nodes: { mini: { runner: LOCAL_RUNNER, token: DEMO_NODE_TOKEN, prefer: true } },
      cloud: { runner: CLOUD_RUNNER },
      paperclip: {
        apiUrl: "http://paperclip.demo.invalid",
        apiKey: "demo-paperclip-key-not-real",
        sharedSecret: DEMO_SECRET,
        labelDeferred: true,
      },
      agents: {
        agent_inbox: { tier: "private" },
        agent_ops: { tier: "internal" },
        agent_research: { tier: "public" },
      },
      policies: [
        { match: { tier: "private" }, available: "local", busy: "local-low", offline: "defer" },
        { match: { tier: "internal" }, available: "local", busy: "cloud", offline: "cloud" },
        { default: { available: "cloud", busy: "cloud", offline: "cloud" } },
      ],
      presence: { offlineAfterSeconds: 90, drainConcurrency: 2, deferredMaxAgeHours: 72 },
    },
    {},
  );
}

function payload(runId: string, agentId: string, issueId: string): Record<string, unknown> {
  return {
    runId,
    agentId,
    context: {
      taskId: issueId,
      companyId: "demo-company",
      wakeReason: "issue_assigned",
      commentId: null,
      labels: [],
    },
    connectionInstructions: null,
  };
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const pause = () => sleep(opts.stepDelayMs ?? 0);
  const started = Date.now();
  const clock = { now: new Date() };
  const config = demoConfig();
  const result: DemoResult = {
    dispatched: [],
    deferred: [],
    wakes: [],
    privateToCloud: 0,
    pendingAtEnd: 0,
    elapsedMs: 0,
  };

  // Fake runners: answer in-process, record which runtime got the run.
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = url === LOCAL_RUNNER ? "local" : url === CLOUD_RUNNER ? "cloud" : null;
    if (!target)
      return new Response(JSON.stringify({ error: "unknown demo url" }), { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { runId?: string; agentId?: string };
    result.dispatched.push({ runId: String(body.runId), target });
    if (target === "cloud" && resolveTier(String(body.agentId), config) === "private") {
      result.privateToCloud += 1;
    }
    write(`  ✓ ${target === "local" ? "mini (Ollama)" : "cloud runtime"} ran ${body.runId}`);
    return new Response(JSON.stringify({ ok: true, runner: target }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  // Fake Paperclip: records comments/labels and wakes.
  const wokenIssues: Array<{ agentId: string; issueId?: string }> = [];
  const paperclip: PaperclipClient = {
    parseRun(body: unknown, headers: Headers): TaskContextInput {
      return parseRun(body, headers);
    },
    async wakeAgent(args) {
      const wake = { agentId: args.agentId, ...(args.issueId ? { issueId: args.issueId } : {}) };
      wokenIssues.push(wake);
      result.wakes.push(wake);
      write(`  ↻ paperclip: wake ${args.agentId}${args.issueId ? ` for ${args.issueId}` : ""}`);
    },
    async commentOnIssue(issueId) {
      write(`  💬 paperclip: comment on ${issueId} (waiting for local)`);
    },
    async addLabel(issueId, label) {
      write(`  🏷  paperclip: label ${issueId} +${label}`);
    },
  };
  const notifier: Notifier = { notify: async () => {} };

  const db = openDb(":memory:");
  try {
    const { app, tick } = createApp({
      config,
      db,
      paperclip,
      notifier,
      logger: createLogger("silent"),
      now: () => clock.now,
      fetch: fakeFetch,
      demo: true,
      demoWrite: write,
    });

    const presence = () =>
      app.request("/presence", {
        method: "POST",
        headers: { authorization: `Bearer ${DEMO_NODE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          node: "mini",
          mode: "auto",
          freeRamGb: 16,
          onBattery: false,
          userIdleSeconds: 30,
          modelsLoaded: ["llama3.2"],
          modelsInstalled: ["llama3.2"],
          agentVersion: "demo",
          sentAt: clock.now.toISOString(),
        }),
      });
    const run = async (runId: string, agentId: string, issueId: string) => {
      const res = await app.request("/run", {
        method: "POST",
        headers: { authorization: `Bearer ${DEMO_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(payload(runId, agentId, issueId)),
      });
      if (res.status === 202) result.deferred.push(runId);
      await res.arrayBuffer();
    };
    const heading = (text: string) => {
      write("");
      write(`▶ ${text}`);
    };

    write(
      "ebbgate demo: real dispatcher, fake Paperclip, fake runners. Nothing leaves this process.",
    );
    write("agents: agent_inbox=private  agent_ops=internal  agent_research=public");

    heading("1. Your Mac (node 'mini') checks in: available");
    await presence();
    await pause();

    heading("2. A private task arrives: runs locally, free, on your Mac");
    await run("run-101", "agent_inbox", "ISS-1");
    await pause();

    heading("3. You close the lid. No heartbeat for 90s, so mini goes offline");
    clock.now = new Date(clock.now.getTime() + 91_000);
    await tick();
    await pause();

    heading("4. An internal task arrives: not private, so it moves to the cloud");
    await run("run-102", "agent_ops", "ISS-2");
    await pause();

    heading("5. A private task arrives: it never goes to the cloud. It waits at the gate");
    await run("run-103", "agent_inbox", "ISS-3");
    await pause();

    heading("6. You open the lid. mini is available again, the queue drains");
    clock.now = new Date(clock.now.getTime() + 5_000);
    await presence();
    await pause();

    // Paperclip re-runs each woken agent; the dispatcher now routes it locally.
    heading("7. Paperclip re-runs the woken agent: the private task runs on your Mac");
    let n = 0;
    for (const wake of wokenIssues.splice(0)) {
      n += 1;
      await run(`run-103-resume-${n}`, wake.agentId, wake.issueId ?? "ISS-3");
    }
    await pause();

    result.pendingAtEnd = (
      db.prepare(`SELECT COUNT(*) AS n FROM deferred WHERE status = 'pending'`).get() as {
        n: number;
      }
    ).n;
    result.elapsedMs = Date.now() - started;

    write("");
    write("Summary");
    for (const d of result.dispatched) write(`  ${d.runId.padEnd(18)} → ${d.target}`);
    write(
      `  deferred: ${result.deferred.join(", ") || "none"}   still waiting: ${result.pendingAtEnd}`,
    );
    write(
      `  private work reached the cloud: ${result.privateToCloud === 0 ? "never" : `${result.privateToCloud} time(s)`}`,
    );
    write("");
    write("Next: https://github.com/patilswapnilv/ebbgate#quickstart");
    return result;
  } finally {
    db.close();
  }
}
