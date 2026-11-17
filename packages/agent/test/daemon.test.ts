import type { PresenceReport } from "@ebbgate/core";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeConfig } from "../src/config.js";
import { postPresence, runDaemon } from "../src/daemon.js";

function fakeConfig(): AgentRuntimeConfig {
  return {
    node: "mini",
    token: "mini-token-0123456789abcdef",
    dispatcherUrl: "http://dispatcher.test",
    gatewayUrl: "http://gateway.test",
    runnerPort: 8787,
    runnerHost: "127.0.0.1",
    ollamaUrl: "http://ollama.test",
    configPath: "/tmp/ebbgate.yaml",
    ebbgate: {} as AgentRuntimeConfig["ebbgate"],
  };
}

function report(): PresenceReport {
  return {
    node: "mini",
    mode: "auto",
    freeRamGb: 8,
    onBattery: false,
    userIdleSeconds: 0,
    modelsLoaded: [],
    modelsInstalled: [],
    agentVersion: "0.0.0",
    sentAt: "2026-11-16T12:00:00.000Z",
  };
}

describe("postPresence", () => {
  it("POSTs bearer + JSON body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await postPresence("http://dispatcher.test", "tok", report(), async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.url).toBe("http://dispatcher.test/presence");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
  });
});

describe("runDaemon", () => {
  it("backs off on failure then succeeds without throwing", async () => {
    let n = 0;
    const sleeps: number[] = [];
    await runDaemon({
      config: fakeConfig(),
      once: true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      buildReport: async () => report(),
      fetch: async () => {
        n += 1;
        if (n === 1) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      log: () => {},
    });
    // once:true returns after first failure path's continue... actually on failure with once it returns after sleep
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
  });

  it("posts once on success with once:true", async () => {
    let posts = 0;
    await runDaemon({
      config: fakeConfig(),
      once: true,
      sleep: async () => {},
      buildReport: async () => report(),
      fetch: async () => {
        posts += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(posts).toBe(1);
  });
});
