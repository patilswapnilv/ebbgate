import { parseConfig } from "@ebbgate/core";
import { createApp, openDb } from "@ebbgate/dispatcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPLAIN_EXIT, runDecisions, runStatusCommand, runWhy } from "../src/explain.js";

const SECRET = "shared-secret-0123456789abcdef";

function config() {
  return parseConfig({
    server: { port: 8790, publicUrl: "http://127.0.0.1:8790" },
    nodes: {
      mini: { runner: "http://127.0.0.1:1/run", token: "mini-token-0123456789abcdef" },
    },
    cloud: { runner: "http://127.0.0.1:2/run" },
    paperclip: { apiUrl: "http://127.0.0.1:3100", apiKey: "pc-test-key", sharedSecret: SECRET },
    agents: { agent_inbox: { tier: "private" }, agent_ops: { tier: "internal" } },
    policies: [
      { match: { tier: "private" }, available: "local", busy: "local-low", offline: "defer" },
      { default: { available: "cloud", busy: "cloud", offline: "defer" } },
    ],
  });
}

describe("ebbgate status / why / decisions against the real dispatcher", () => {
  let db: ReturnType<typeof openDb>;
  let handle: ReturnType<typeof createApp>;
  let out: string[];
  let err: string[];
  const now = new Date("2026-11-23T10:05:00.000Z");

  const fetchViaApp: typeof fetch = async (input, init) =>
    handle.app.fetch(new Request(String(input), init));
  const env = { EG_PAPERCLIP_SECRET: SECRET, EBBGATE_DISPATCHER_URL: "http://dispatcher.test" };
  const deps = (extraEnv: Record<string, string | undefined> = {}) => ({
    env: { ...env, ...extraEnv },
    fetch: fetchViaApp,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    now: () => now,
    localStatus: async () => "LOCAL-ONLY STATUS",
  });

  async function deferPrivate(runId: string) {
    const res = await handle.app.request("/run", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        runId,
        agentId: "agent_inbox",
        context: { taskId: `issue-${runId}`, companyId: "co", labels: [] },
      }),
    });
    expect(res.status).toBe(202);
  }

  beforeEach(() => {
    out = [];
    err = [];
    db = openDb(":memory:");
    handle = createApp({
      config: config(),
      db,
      paperclip: {
        parseRun: (body: unknown) => {
          const b = body as { runId: string; agentId: string; context: { taskId: string } };
          return {
            runId: b.runId,
            agentId: b.agentId,
            companyId: "co",
            issueId: b.context.taskId,
            labels: [],
          };
        },
        commentOnIssue: async () => {},
        addLabel: async () => {},
        wakeAgent: async () => {},
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake for the client interface
      } as any,
      now: () => new Date("2026-11-23T10:00:00.000Z"),
      demo: false,
    });
  });

  afterEach(() => db.close());

  it("status shows presence, queue counts and why each task waits", async () => {
    await deferPrivate("run-1");
    expect(await runStatusCommand([], deps())).toBe(EXPLAIN_EXIT.ok);
    const text = out.join("\n");
    expect(text).toContain("presence: ○ offline");
    expect(text).toContain("queue: 1 held (1 pending, 0 waking)");
    expect(text).toContain("run-1");
    expect(text).toContain("5m");
    expect(text).toContain(
      "HELD_PRIVATE_MAC_OFFLINE: held because it's private and your Mac is offline",
    );
    expect(text).toContain("top reason: HELD_PRIVATE_MAC_OFFLINE (1)");
  });

  it("status --json prints the dispatcher's answer", async () => {
    await deferPrivate("run-1");
    expect(await runStatusCommand(["--json"], deps())).toBe(EXPLAIN_EXIT.ok);
    const body = JSON.parse(out.join("\n"));
    expect(body.queue.held).toBe(1);
    expect(body.waiting[0].code).toBe("HELD_PRIVATE_MAC_OFFLINE");
  });

  it("status without a dispatcher secret falls back to the node-local view", async () => {
    expect(await runStatusCommand([], deps({ EG_PAPERCLIP_SECRET: undefined }))).toBe(0);
    expect(out).toEqual(["LOCAL-ONLY STATUS"]);
    expect(await runStatusCommand(["--json"], deps({ EG_PAPERCLIP_SECRET: undefined }))).toBe(2);
    expect(err.at(-1)).toContain("no dispatcher secret");
  });

  it("why explains a waiting task; unknown tasks exit 1", async () => {
    await deferPrivate("run-1");
    expect(await runWhy(["run-1"], deps())).toBe(EXPLAIN_EXIT.ok);
    expect(out[0]).toContain(
      "run-1: waiting for 5m, HELD_PRIVATE_MAC_OFFLINE: held because it's private and your Mac is offline",
    );
    expect(out[0]).toContain("history (newest first)");

    out = [];
    expect(await runWhy(["run-1", "--json"], deps())).toBe(EXPLAIN_EXIT.ok);
    const body = JSON.parse(out.join("\n"));
    expect(body.taskId).toBe("run-1");
    expect(body.decisions[0]).toMatchObject({ code: "HELD_PRIVATE_MAC_OFFLINE", target: "queue" });

    out = [];
    expect(await runWhy(["nope"], deps())).toBe(EXPLAIN_EXIT.notFound);
    expect(out[0]).toContain("no decisions recorded");
  });

  it("why and decisions fail closed on usage and transport errors", async () => {
    expect(await runWhy([], deps())).toBe(EXPLAIN_EXIT.error);
    expect(await runWhy(["a b"], deps())).toBe(EXPLAIN_EXIT.error);
    expect(await runWhy(["x", "--bogus"], deps())).toBe(EXPLAIN_EXIT.error);
    expect(await runDecisions(["--kind"], deps())).toBe(EXPLAIN_EXIT.error);
    expect(await runDecisions(["--kind", "other"], deps())).toBe(EXPLAIN_EXIT.error);
    expect(err.at(-1)).toContain("HTTP 400");
    expect(await runWhy(["x"], deps({ EG_PAPERCLIP_SECRET: "wrong-secret-0123456789" }))).toBe(
      EXPLAIN_EXIT.error,
    );
    expect(err.at(-1)).toContain("HTTP 401");
    const unreachable = {
      ...deps(),
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    };
    expect(await runDecisions([], unreachable)).toBe(EXPLAIN_EXIT.error);
    expect(err.at(-1)).toContain("dispatcher unreachable");
  });

  it("decisions lists the audit log with filters", async () => {
    await deferPrivate("run-1");
    await deferPrivate("run-2");
    expect(await runDecisions(["--limit", "1"], deps())).toBe(EXPLAIN_EXIT.ok);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("run-2");
    expect(out[0]).toContain("defer -> queue");

    out = [];
    expect(await runDecisions(["--task=run-1", "--json"], deps())).toBe(EXPLAIN_EXIT.ok);
    const list = JSON.parse(out.join("\n"));
    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe("run-1");

    out = [];
    expect(await runDecisions(["--kind", "admission"], deps())).toBe(EXPLAIN_EXIT.ok);
    expect(out).toEqual(["no decisions recorded"]);
  });

  it("the secret can come from a file", async () => {
    await deferPrivate("run-1");
    const code = await runWhy(["run-1", "--secret-file", "/s"], {
      ...deps({ EG_PAPERCLIP_SECRET: undefined }),
      readFile: () => `${SECRET}\n`,
    });
    expect(code).toBe(EXPLAIN_EXIT.ok);
  });
});
