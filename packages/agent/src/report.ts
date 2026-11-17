import { PRESENCE_LIMITS, type PresenceReport } from "@ebbgate/core";
import { onBattery } from "./collectors/battery.js";
import { userIdleSeconds } from "./collectors/idle.js";
import { withFallback } from "./collectors/limits.js";
import { type OllamaSnapshot, probeOllama } from "./collectors/ollama.js";
import { freeRamGb } from "./collectors/ram.js";
import { readMode } from "./mode.js";
import { AGENT_VERSION } from "./paths.js";

export interface PresenceCollectors {
  freeRamGb: () => Promise<number>;
  onBattery: () => Promise<boolean>;
  userIdleSeconds: () => Promise<number>;
  probeOllama: (baseUrl: string, fetchFn: typeof fetch) => Promise<OllamaSnapshot>;
}

const defaultCollectors: PresenceCollectors = {
  freeRamGb: () => freeRamGb(),
  onBattery: () => onBattery(),
  userIdleSeconds: () => userIdleSeconds(),
  probeOllama,
};

export interface BuildReportOptions {
  node: string;
  ollamaUrl: string;
  now?: () => Date;
  fetch?: typeof fetch;
  /** Override collectors (tests). */
  collectors?: Partial<PresenceCollectors>;
  /** Per-collector deadline before its fallback value is used. */
  collectorDeadlineMs?: number;
}

/**
 * Keep a model inventory within the presence schema: drop names that are too
 * long, deduplicate, and cap the list. An oversized inventory would otherwise
 * be rejected on every retry.
 */
export function normalizeModels(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (out.length >= PRESENCE_LIMITS.maxModels) break;
    if (!name || name.length > PRESENCE_LIMITS.maxModelNameLength || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export async function buildPresenceReport(opts: BuildReportOptions): Promise<PresenceReport> {
  const now = opts.now ?? (() => new Date());
  const fetchFn = opts.fetch ?? fetch;
  const c = { ...defaultCollectors, ...opts.collectors };
  const ms = opts.collectorDeadlineMs;
  const emptyOllama: OllamaSnapshot = { modelsLoaded: [], modelsInstalled: [] };

  const [freeRam, battery, idle, ollama] = await Promise.all([
    withFallback(c.freeRamGb(), 0, ms),
    withFallback(c.onBattery(), false, ms),
    withFallback(c.userIdleSeconds(), 0, ms),
    withFallback(c.probeOllama(opts.ollamaUrl, fetchFn), emptyOllama, ms),
  ]);

  return {
    node: opts.node,
    mode: readMode(),
    freeRamGb: freeRam,
    onBattery: battery,
    userIdleSeconds: idle,
    modelsLoaded: normalizeModels(ollama.modelsLoaded),
    modelsInstalled: normalizeModels(ollama.modelsInstalled),
    agentVersion: AGENT_VERSION,
    sentAt: now().toISOString(),
  };
}
