/**
 * Shared harness for the privacy-guarantee suite.
 *
 * The oracle is a recording `fetch`: every byte the dispatcher sends anywhere
 * goes through it, so "did a private task reach the cloud runner?" is answered by
 * looking at what actually left the process, not at what the code meant to do.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EbbgateConfig, parseConfig, type Tier } from "@ebbgate/core";
import { expect } from "vitest";
import { createApp } from "../../src/app.js";
import { type Db, openDb } from "../../src/db/index.js";
import { createLogger } from "../../src/logger.js";
import { createFakePaperclip, type FakePaperclip } from "../helpers/fake-paperclip.js";

export const SECRET = "shared-secret-0123456789abcdef";
export const MINI_TOKEN = "mini-token-0123456789abcdef";
export const MBP_TOKEN = "mbp-token-0123456789abcdef";
export const CLOUD_RUNNER = "http://cloud.invalid:18789/paperclip";
export const MINI_RUNNER = "http://mini.invalid:8787/run";
export const MBP_RUNNER = "http://mbp.invalid:8787/run";
export const T0 = new Date("2026-11-23T10:00:00.000Z");

/** Agents in the config, with the tier the operator gave them. */
export const AGENTS: Record<string, Tier> = {
  agent_inbox: "private",
  agent_finance: "private",
  agent_ops: "internal",
  agent_research: "public",
};

/**
 * Agent ids that are NOT in the config. Every one of them must be treated as
 * private. Several are chosen to collide with Object.prototype members or to be
 * near-misses of configured ids.
 */
export const UNKNOWN_AGENTS = [
  "agent_unlisted",
  "AGENT_RESEARCH",
  "agent_research ",
  " agent_research",
  "agent_research\u0000",
  "agent_reseаrch", // Cyrillic "а"
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "prototype",
  "valueOf",
];

/** True when the operator explicitly configured this agent as cloud-eligible. */
export function cloudEligible(agentId: unknown): boolean {
  if (typeof agentId !== "string" || !Object.hasOwn(AGENTS, agentId)) return false;
  const tier = AGENTS[agentId];
  return tier === "internal" || tier === "public";
}

/**
 * The most cloud-hungry config validation accepts: every non-private tier and
 * the default rule send work to the cloud in every state.
 */
export function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: { port: 8790, publicUrl: "http://127.0.0.1:8790", runnerTimeoutMs: 1_000 },
    nodes: {
      mini: { runner: MINI_RUNNER, token: MINI_TOKEN, prefer: true },
      mbp: { runner: MBP_RUNNER, token: MBP_TOKEN },
    },
    cloud: { runner: CLOUD_RUNNER },
    paperclip: {
      apiUrl: "http://paperclip.invalid:3100",
      apiKey: "pc-test-key-not-a-secret-value",
      sharedSecret: SECRET,
      labelDeferred: true,
    },
    agents: Object.fromEntries(Object.entries(AGENTS).map(([id, tier]) => [id, { tier }])),
    policies: [
      {
        match: { label: "local-files" },
        available: "local",
        busy: "local-low",
        offline: "defer",
        notify: true,
      },
      { match: { tier: "private" }, available: "local", busy: "local-low", offline: "defer" },
      { match: { tier: "internal" }, available: "cloud", busy: "cloud", offline: "cloud" },
      { default: { available: "cloud", busy: "cloud", offline: "cloud" } },
    ],
    presence: { offlineAfterSeconds: 30, drainConcurrency: 2, deferredMaxAgeHours: 72 },
    ...overrides,
  };
}

export function config(overrides: Record<string, unknown> = {}): EbbgateConfig {
  return parseConfig(rawConfig(overrides));
}

export interface Sent {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A fetch that records every outbound request and can hold responses open. */
export function recordingFetch() {
  const sent: Sent[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  let failUrls = new Set<string>();
  const fn: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = typeof init?.body === "string" ? init.body : null;
    let body: unknown = raw;
    try {
      body = raw === null ? null : JSON.parse(raw);
    } catch {
      /* keep raw */
    }
    sent.push({ url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (gate) await gate;
    if (failUrls.has(url)) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fn,
    sent,
    toCloud: () => sent.filter((s) => sameUrl(s.url, CLOUD_RUNNER)),
    toLocal: () => sent.filter((s) => sameUrl(s.url, MINI_RUNNER) || sameUrl(s.url, MBP_RUNNER)),
    hold() {
      gate = new Promise((r) => {
        open = r;
      });
    },
    release() {
      open?.();
      gate = null;
    },
    failFor(urls: string[]) {
      failUrls = new Set(urls);
    },
  };
}

function sameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

export function silentLogger() {
  return createLogger("silent");
}

export interface Harness {
  db: Db;
  dbPath: string;
  clock: { now: Date };
  net: ReturnType<typeof recordingFetch>;
  paperclip: FakePaperclip;
  handle: ReturnType<typeof createApp>;
  cfg: EbbgateConfig;
  /** Simulate a process restart: same database file, fresh app, same network tap. */
  restart(cfg?: EbbgateConfig): Harness["handle"];
  close(): void;
}

/** A dispatcher on a file-backed SQLite database, so restarts are real. */
export function harness(cfg: EbbgateConfig = config()): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ebbgate-privacy-"));
  const dbPath = join(dir, "ebbgate.db");
  const clock = { now: new Date(T0) };
  const net = recordingFetch();
  const paperclip = createFakePaperclip();
  const h: Harness = {
    db: openDb(dbPath),
    dbPath,
    clock,
    net,
    paperclip,
    cfg,
    handle: undefined as unknown as Harness["handle"],
    restart(next = h.cfg) {
      h.db.close();
      h.db = openDb(dbPath);
      h.cfg = next;
      h.handle = build();
      return h.handle;
    },
    close() {
      try {
        h.db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  function build() {
    return createApp({
      config: h.cfg,
      db: h.db,
      paperclip,
      logger: silentLogger(),
      now: () => clock.now,
      fetch: net.fn,
      demo: false,
    });
  }
  h.handle = build();
  return h;
}

export function runPayload(
  runId: string,
  agentId: string,
  context: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId,
    agentId,
    context: {
      taskId: `issue-${runId}`,
      companyId: "company-test",
      wakeReason: "issue_assigned",
      labels: [],
      ...context,
    },
  };
}

export function postRun(h: Harness, body: unknown): Promise<Response> {
  return Promise.resolve(
    h.handle.app.request("/run", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

export function postAdmit(h: Harness, body: unknown): Promise<Response> {
  return Promise.resolve(
    h.handle.app.request("/admit", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export function presenceReport(
  node: "mini" | "mbp",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node,
    mode: "auto",
    freeRamGb: 16,
    onBattery: false,
    userIdleSeconds: 5,
    modelsLoaded: [],
    modelsInstalled: ["llama3"],
    agentVersion: "test",
    sentAt: T0.toISOString(),
    ...extra,
  };
}

export function postPresence(
  h: Harness,
  node: "mini" | "mbp",
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return Promise.resolve(
    h.handle.app.request("/presence", {
      method: "POST",
      headers: {
        authorization: `Bearer ${node === "mini" ? MINI_TOKEN : MBP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(presenceReport(node, extra)),
    }),
  );
}

/**
 * The guarantee, checked against what actually left the process and what was
 * recorded: no request to the cloud runner carries a task whose agent is not
 * explicitly cloud-eligible, and no cloud decision was ever recorded for one.
 */
export function assertNoPrivateLeak(h: Harness): void {
  for (const hit of h.net.toCloud()) {
    // The dispatcher's own credential never goes to the cloud runner either.
    expect(JSON.stringify(hit.headers)).not.toContain(SECRET);
    const agentId = (hit.body as { agentId?: unknown } | null)?.agentId;
    expect(
      cloudEligible(agentId),
      `cloud runner received a task for agent ${JSON.stringify(agentId)}`,
    ).toBe(true);
  }
  const cloudDecisions = h.db
    .prepare(`SELECT agent_id, tier FROM decisions WHERE action = 'cloud'`)
    .all() as Array<{ agent_id: string; tier: string }>;
  for (const d of cloudDecisions) {
    expect(d.tier === "internal" || d.tier === "public").toBe(true);
    expect(cloudEligible(d.agent_id)).toBe(true);
  }
  const cloudRuns = h.db
    .prepare(`SELECT agent_id FROM runs WHERE target = 'cloud'`)
    .all() as Array<{ agent_id: string }>;
  for (const r of cloudRuns) expect(cloudEligible(r.agent_id)).toBe(true);
}
