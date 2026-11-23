import { parseConfig } from "@ebbgate/core";
import { createApp, openDb } from "@ebbgate/dispatcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIT_EXIT, parseAdmitArgs, runAdmit } from "../src/admit.js";

const SECRET = "shared-secret-0123456789abcdef";
const NODE_TOKEN = "mini-token-0123456789abcdef";

function config() {
  return parseConfig({
    server: { port: 8790, publicUrl: "http://127.0.0.1:8790" },
    nodes: { mini: { runner: "http://127.0.0.1:1/run", token: NODE_TOKEN, prefer: true } },
    cloud: { runner: "http://127.0.0.1:2/run" },
    paperclip: { apiUrl: "http://127.0.0.1:3100", apiKey: "pc-test-key", sharedSecret: SECRET },
    agents: { agent_inbox: { tier: "private" }, agent_ops: { tier: "internal" } },
    policies: [
      { match: { tier: "private" }, available: "local", busy: "local-low", offline: "defer" },
      { match: { tier: "internal" }, available: "local", busy: "cloud", offline: "cloud" },
      { default: { available: "cloud", busy: "cloud", offline: "cloud" } },
    ],
    presence: { offlineAfterSeconds: 90 },
  });
}

describe("ebbgate admit against the real dispatcher", () => {
  let db: ReturnType<typeof openDb>;
  let handle: ReturnType<typeof createApp>;
  let logs: string[];
  const clock = { now: new Date("2026-11-23T10:00:00.000Z") };

  const fetchViaApp: typeof fetch = async (input, init) =>
    handle.app.fetch(new Request(String(input), init));
  const env = { EG_PAPERCLIP_SECRET: SECRET, EBBGATE_DISPATCHER_URL: "http://dispatcher.test" };
  const admit = (argv: string[], extraEnv: Record<string, string> = {}) =>
    runAdmit(argv, { env: { ...env, ...extraEnv }, fetch: fetchViaApp, log: (l) => logs.push(l) });

  async function macOnline() {
    const res = await handle.app.request("/presence", {
      method: "POST",
      headers: { authorization: `Bearer ${NODE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        node: "mini",
        mode: "auto",
        freeRamGb: 16,
        onBattery: false,
        userIdleSeconds: 5,
        modelsLoaded: [],
        modelsInstalled: [],
        agentVersion: "test",
        sentAt: clock.now.toISOString(),
      }),
    });
    expect(res.status).toBe(200);
  }

  beforeEach(() => {
    logs = [];
    db = openDb(":memory:");
    handle = createApp({
      config: config(),
      db,
      paperclip: {
        parseRun: () => {
          throw new Error("unused");
        },
        wakeAgent: async () => {},
        commentOnIssue: async () => {},
        addLabel: async () => {},
      },
      now: () => clock.now,
      demo: false,
    });
  });
  afterEach(() => db.close());

  it("private + Mac offline: refuses the Mac and remote", async () => {
    expect(await admit(["--node", "mini", "--agent", "agent_inbox"])).toBe(ADMIT_EXIT.refuse);
    expect(await admit(["--remote", "--agent", "agent_inbox"])).toBe(ADMIT_EXIT.refuse);
  });

  it("private + Mac available: admits the Mac only", async () => {
    await macOnline();
    expect(await admit(["--node", "mini", "--agent", "agent_inbox"])).toBe(ADMIT_EXIT.admit);
    expect(await admit(["--remote", "--agent", "agent_inbox"])).toBe(ADMIT_EXIT.refuse);
  });

  it("internal + Mac offline: admits remote, refuses the Mac", async () => {
    expect(await admit(["--remote", "--agent", "agent_ops", "--labels", ""])).toBe(
      ADMIT_EXIT.admit,
    );
    expect(await admit(["--node", "mini", "--agent", "agent_ops"])).toBe(ADMIT_EXIT.refuse);
  });

  it("no agent id (Paperclip passes no context today) is private", async () => {
    expect(await admit(["--remote"])).toBe(ADMIT_EXIT.refuse);
    expect(logs.at(-1)).toContain("tier=private");
  });

  it("issue privacy flag only tightens", async () => {
    expect(await admit(["--remote", "--agent", "agent_ops", "--private"])).toBe(ADMIT_EXIT.refuse);
    expect(await admit(["--remote", "--agent", "agent_ops"], { EBBGATE_ISSUE_PRIVATE: "1" })).toBe(
      ADMIT_EXIT.refuse,
    );
  });

  it("env vars work as inputs; flags win", async () => {
    expect(
      await admit([], { EBBGATE_REMOTE: "1", EBBGATE_AGENT_ID: "agent_ops", EBBGATE_LABELS: "" }),
    ).toBe(ADMIT_EXIT.admit);
    expect(
      await admit(["--agent", "agent_inbox"], {
        EBBGATE_REMOTE: "1",
        EBBGATE_AGENT_ID: "agent_ops",
      }),
    ).toBe(ADMIT_EXIT.refuse);
  });

  it("wrong secret fails closed", async () => {
    expect(
      await admit(["--remote", "--agent", "agent_ops"], {
        EG_PAPERCLIP_SECRET: "wrong-secret-0123456789abcd",
      }),
    ).toBe(ADMIT_EXIT.error);
    expect(logs.at(-1)).toContain("HTTP 401");
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("unknown node fails closed", async () => {
    expect(await admit(["--node", "nope", "--agent", "agent_ops"])).toBe(ADMIT_EXIT.refuse);
  });
});

describe("ebbgate admit fails closed", () => {
  const base = { EG_PAPERCLIP_SECRET: SECRET };
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);

  it("on usage errors", async () => {
    expect(await runAdmit([], { env: base, log })).toBe(ADMIT_EXIT.error);
    expect(await runAdmit(["--node", "mini", "--remote"], { env: base, log })).toBe(
      ADMIT_EXIT.error,
    );
    expect(await runAdmit(["--remote"], { env: {}, log })).toBe(ADMIT_EXIT.error);
    expect(await runAdmit(["--remote", "--bogus"], { env: base, log })).toBe(ADMIT_EXIT.error);
    expect(await runAdmit(["--remote", "--timeout-ms", "60000"], { env: base, log })).toBe(
      ADMIT_EXIT.error,
    );
  });

  it("when the dispatcher is unreachable", async () => {
    const fetchFail: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await runAdmit(["--remote"], { env: base, fetch: fetchFail, log })).toBe(
      ADMIT_EXIT.error,
    );
  });

  it("when the dispatcher hangs (bounded by --timeout-ms)", async () => {
    const hang: typeof fetch = (_i, init) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const started = Date.now();
    expect(
      await runAdmit(["--remote", "--timeout-ms", "200"], { env: base, fetch: hang, log }),
    ).toBe(ADMIT_EXIT.error);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logs.at(-1)).toContain("did not answer within 200 ms");
  });

  it("on malformed answers", async () => {
    for (const body of ["not json", JSON.stringify({ admit: "yes" }), JSON.stringify({})]) {
      const f: typeof fetch = async () => new Response(body, { status: 200 });
      expect(await runAdmit(["--remote"], { env: base, fetch: f, log })).toBe(ADMIT_EXIT.error);
    }
    const f500: typeof fetch = async () => new Response("{}", { status: 500 });
    expect(await runAdmit(["--remote"], { env: base, fetch: f500, log })).toBe(ADMIT_EXIT.error);
  });

  it("reads the secret from a file, never argv", () => {
    const args = parseAdmitArgs(["--remote", "--secret-file", "/x"], {}, () => `${SECRET}\n`);
    expect(args.secret).toBe(SECRET);
    expect(() => parseAdmitArgs(["--remote", "--secret", SECRET], base, () => "")).toThrow(
      /unknown flag/,
    );
  });
});
