import type { PresenceReport } from "@ebbgate/core";
import { onBattery } from "./collectors/battery.js";
import { userIdleSeconds } from "./collectors/idle.js";
import { probeOllama } from "./collectors/ollama.js";
import { freeRamGb } from "./collectors/ram.js";
import { readMode } from "./mode.js";
import { AGENT_VERSION } from "./paths.js";

export interface BuildReportOptions {
  node: string;
  ollamaUrl: string;
  now?: () => Date;
  fetch?: typeof fetch;
}

export async function buildPresenceReport(opts: BuildReportOptions): Promise<PresenceReport> {
  const now = opts.now ?? (() => new Date());
  const fetchFn = opts.fetch ?? fetch;

  const [freeRam, battery, idle, ollama] = await Promise.all([
    freeRamGb(),
    onBattery(),
    userIdleSeconds(),
    probeOllama(opts.ollamaUrl, fetchFn),
  ]);

  return {
    node: opts.node,
    mode: readMode(),
    freeRamGb: freeRam,
    onBattery: battery,
    userIdleSeconds: idle,
    modelsLoaded: ollama.modelsLoaded,
    modelsInstalled: ollama.modelsInstalled,
    agentVersion: AGENT_VERSION,
    sentAt: now().toISOString(),
  };
}
