/**
 * Privacy guarantee, `ebbgate admit` (Paperclip admissionCommand): the probe
 * must refuse unless the dispatcher clearly admits, and must refuse private work
 * for a remote environment even if the dispatcher says otherwise.
 */
import { parseConfig } from "@ebbgate/core";
import { createApp, openDb } from "@ebbgate/dispatcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIT_EXIT, runAdmit } from "../../src/admit.js";

const SECRET = "shared-secret-0123456789abcdef";
const env = { EG_PAPERCLIP_SECRET: SECRET, EBBGATE_DISPATCHER_URL: "http://dispatcher.test" };

function config() {
  return parseConfig({
    server: { publicUrl: "http://127.0.0.1:8790" },
    nodes: { mini: { runner: "http://127.0.0.1:1/run", token: "mini-token-0123456789abcdef" } },
    cloud: { runner: "http://127.0.0.1:2/run" },
    paperclip: { apiUrl: "http://127.0.0.1:3100", apiKey: "k", sharedSecret: SECRET },
    agents: { agent_inbox: { tier: "private" }, agent_research: { tier: "public" } },
    policies: [
      { match: { tier: "private" }, available: "local", busy: "local-low", offline: "defer" },
      { default: { available: "cloud", busy: "cloud", offline: "cloud" } },
    ],
  });
}

/** A dispatcher stand-in that answers whatever we tell it to. */
function lyingDispatcher(answer: unknown, status = 200): typeof fetch {
  return async () =>
    new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status });
}

describe("privacy guarantee: ebbgate admit", () => {
  let db: ReturnType<typeof openDb>;
  let handle: ReturnType<typeof createApp>;
  const logs: string[] = [];
  const realFetch: typeof fetch = async (input, init) =>
    handle.app.fetch(new Request(String(input), init));
  const admit = (argv: string[], fetchFn: typeof fetch = realFetch, extra = {}) =>
    runAdmit(argv, { env: { ...env, ...extra }, fetch: fetchFn, log: (l) => logs.push(l) });

  beforeEach(() => {
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
      now: () => new Date("2026-11-23T10:00:00.000Z"),
      demo: false,
    });
  });
  afterEach(() => db.close());

  it("Mac offline: private, unknown and agent-less probes refuse on the node and remotely", async () => {
    for (const agent of [["--agent", "agent_inbox"], ["--agent", "unlisted"], []]) {
      expect(await admit(["--remote", ...agent]), agent.join(" ")).not.toBe(ADMIT_EXIT.admit);
      expect(await admit(["--node", "mini", ...agent]), agent.join(" ")).not.toBe(ADMIT_EXIT.admit);
    }
    // Paperclip passes no context today: the bare probe must refuse remote.
    expect(await admit(["--remote"])).toBe(ADMIT_EXIT.refuse);
  });

  it("--private wins over a public agent", async () => {
    expect(await admit(["--remote", "--agent", "agent_research", "--labels", ""])).toBe(
      ADMIT_EXIT.admit,
    );
    expect(
      await admit(["--remote", "--agent", "agent_research", "--labels", "", "--private"]),
    ).toBe(ADMIT_EXIT.refuse);
    expect(
      await admit(["--remote", "--agent", "agent_research", "--labels", ""], realFetch, {
        EBBGATE_ISSUE_PRIVATE: "true",
      }),
    ).toBe(ADMIT_EXIT.refuse);
  });

  it("FIXED: a dispatcher that wrongly admits private work remotely is overruled by the probe", async () => {
    for (const answer of [
      { admit: true, tier: "private", reason: "bug" },
      { admit: true, reason: "no tier" },
      { admit: true, tier: "PUBLIC" },
      { admit: true, tier: null },
    ]) {
      expect(
        await admit(["--remote", "--agent", "x"], lyingDispatcher(answer)),
        JSON.stringify(answer),
      ).toBe(ADMIT_EXIT.refuse);
    }
    expect(
      await admit(["--remote", "--private"], lyingDispatcher({ admit: true, tier: "public" })),
    ).toBe(ADMIT_EXIT.refuse);
  });

  it("anything other than a clear JSON admit refuses", async () => {
    const answers: Array<[unknown, number]> = [
      [{ admit: "true", tier: "public" }, 200],
      [{ admit: 1, tier: "public" }, 200],
      [{}, 200],
      ["not json", 200],
      ["", 200],
      [{ admit: true, tier: "public" }, 500],
      [{ admit: true, tier: "public" }, 401],
    ];
    for (const [answer, status] of answers) {
      const code = await admit(
        ["--remote", "--agent", "agent_research"],
        lyingDispatcher(answer, status),
      );
      expect(code, `${JSON.stringify(answer)} ${status}`).not.toBe(ADMIT_EXIT.admit);
    }
  });

  it("an unreachable or hanging dispatcher refuses within the timeout", async () => {
    const unreachable: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await admit(["--remote", "--agent", "agent_research"], unreachable)).toBe(
      ADMIT_EXIT.error,
    );
    const hanging: typeof fetch = (_i, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const started = Date.now();
    expect(
      await admit(["--remote", "--agent", "agent_research", "--timeout-ms", "150"], hanging),
    ).toBe(ADMIT_EXIT.error);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("usage errors refuse (no flags, both targets, missing secret)", async () => {
    expect(await admit([])).toBe(ADMIT_EXIT.error);
    expect(await admit(["--remote", "--node", "mini"])).toBe(ADMIT_EXIT.error);
    expect(await runAdmit(["--remote"], { env: {}, fetch: realFetch, log: () => {} })).toBe(
      ADMIT_EXIT.error,
    );
  });
});
