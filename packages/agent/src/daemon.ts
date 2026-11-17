import type { PresenceReport } from "@ebbgate/core";
import { nextBackoffMs } from "./backoff.js";
import type { AgentRuntimeConfig } from "./config.js";
import { DEFAULT_INTERVAL_MS } from "./paths.js";
import { buildPresenceReport } from "./report.js";

export interface DaemonDeps {
  config: AgentRuntimeConfig;
  intervalMs?: number;
  fetch?: typeof fetch;
  buildReport?: (opts: {
    node: string;
    ollamaUrl: string;
    fetch?: typeof fetch;
  }) => Promise<PresenceReport>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, err?: unknown) => void;
  /** When true, run a single tick then return (tests). */
  once?: boolean;
  signal?: AbortSignal;
}

export async function postPresence(
  dispatcherUrl: string,
  token: string,
  report: PresenceReport,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(`${dispatcherUrl}/presence`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`presence POST failed: ${res.status}`);
  }
}

/**
 * Presence loop: every interval, collect + POST. On failure, exponential
 * backoff then continue. Never throws out of the loop.
 */
export async function runDaemon(deps: DaemonDeps): Promise<void> {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchFn = deps.fetch ?? fetch;
  const build = deps.buildReport ?? buildPresenceReport;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((msg, err) => console.error(msg, err ?? ""));

  let failures = 0;

  while (!deps.signal?.aborted) {
    try {
      const report = await build({
        node: deps.config.node,
        ollamaUrl: deps.config.ollamaUrl,
        fetch: fetchFn,
      });
      await postPresence(deps.config.dispatcherUrl, deps.config.token, report, fetchFn);
      failures = 0;
    } catch (err) {
      failures += 1;
      log("ebbgate agent: presence tick failed", err);
      const wait = nextBackoffMs(failures - 1);
      await sleep(wait);
      if (deps.once) return;
      continue;
    }

    if (deps.once) return;
    await sleep(intervalMs);
  }
}
