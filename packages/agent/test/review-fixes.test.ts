import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESENCE_LIMITS, parsePresenceReport } from "@ebbgate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onBattery } from "../src/collectors/battery.js";
import { userIdleSeconds } from "../src/collectors/idle.js";
import { COLLECTOR_TIMEOUT_MS } from "../src/collectors/limits.js";
import { freeRamGb } from "../src/collectors/ram.js";
import { buildLaunchAgentPlist, resolveInstallSettings } from "../src/install.js";
import { DEFAULT_DISPATCHER_URL, DEFAULT_RUNNER_HOST, EBBGATE_DIR } from "../src/paths.js";
import { buildPresenceReport, normalizeModels } from "../src/report.js";

describe("native collectors are bounded", () => {
  it.each([
    ["pmset", onBattery],
    ["ioreg", userIdleSeconds],
    ["vm_stat", freeRamGb],
  ] as const)("%s runs with a timeout and SIGKILL", async (_name, collector) => {
    let seen: { timeout?: number; killSignal?: string } | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: exec stub matching promisified execFile
    const exec: any = async (_cmd: string, _args: string[], opts: typeof seen) => {
      seen = opts;
      throw new Error("stub");
    };
    await collector(exec);
    expect(seen?.timeout).toBe(COLLECTOR_TIMEOUT_MS);
    expect(seen?.killSignal).toBe("SIGKILL");
  });

  it("still sends a report when a collector never settles", async () => {
    const never = new Promise<never>(() => {});
    const started = Date.now();
    const report = await buildPresenceReport({
      node: "mini",
      ollamaUrl: "http://ollama.test",
      collectorDeadlineMs: 50,
      collectors: {
        onBattery: () => never,
        userIdleSeconds: () => never,
        freeRamGb: async () => 12,
        probeOllama: () => never,
      },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report).toMatchObject({ freeRamGb: 12, onBattery: false, userIdleSeconds: 0 });
    expect(parsePresenceReport(report).ok).toBe(true);
  });
});

describe("model inventories respect the presence schema", () => {
  it("caps, deduplicates and drops over-long names", () => {
    const many = Array.from({ length: 600 }, (_, i) => `model-${i}:latest`);
    const names = [...many, "x".repeat(PRESENCE_LIMITS.maxModelNameLength + 1), "model-0:latest"];
    const out = normalizeModels(names);
    expect(out).toHaveLength(PRESENCE_LIMITS.maxModels);
    expect(out.every((n) => n.length <= PRESENCE_LIMITS.maxModelNameLength)).toBe(true);
    expect(new Set(out).size).toBe(out.length);
  });

  it("produces a report the dispatcher accepts, even with 600 installed models", async () => {
    const huge = Array.from({ length: 600 }, (_, i) => `m${i}`);
    const report = await buildPresenceReport({
      node: "mini",
      ollamaUrl: "http://ollama.test",
      collectors: {
        freeRamGb: async () => 8,
        onBattery: async () => false,
        userIdleSeconds: async () => 3,
        probeOllama: async () => ({ modelsLoaded: huge, modelsInstalled: huge }),
      },
    });
    const parsed = parsePresenceReport(report);
    expect(parsed.ok).toBe(true);
  });
});

describe("install settings are resolved and persisted", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-agent-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records an absolute config path even when --config is omitted", () => {
    const cfg = join(dir, "ebbgate.yaml");
    writeFileSync(cfg, "x: 1\n");
    const s = resolveInstallSettings({}, { EBBGATE_CONFIG: cfg }, {});
    expect(s.configPath).toBe(cfg);
  });

  it("fails before installing when no config can be found", () => {
    const cwd = process.cwd();
    try {
      process.chdir(dir); // no ebbgate.yaml here
      expect(() => resolveInstallSettings({}, { HOME: dir }, {})).toThrow(/ebbgate\.yaml/);
    } finally {
      process.chdir(cwd);
    }
  });

  it("uses option -> environment -> saved value -> default, for every endpoint", () => {
    const local = { configPath: "/saved/ebbgate.yaml", dispatcherUrl: "http://saved:8790" };
    const env = {
      EBBGATE_DISPATCHER_URL: "http://env:8790/",
      EBBGATE_GATEWAY_URL: "http://env-gw/paperclip",
      EBBGATE_RUNNER_HOST: "100.64.0.5",
    };
    const fromEnv = resolveInstallSettings({}, env, local);
    expect(fromEnv.dispatcherUrl).toBe("http://env:8790");
    expect(fromEnv.gatewayUrl).toBe("http://env-gw/paperclip");
    expect(fromEnv.runnerHost).toBe("100.64.0.5");
    expect(fromEnv.configPath).toBe("/saved/ebbgate.yaml");

    const explicit = resolveInstallSettings({ dispatcherUrl: "http://opt:8790" }, env, local);
    expect(explicit.dispatcherUrl).toBe("http://opt:8790");

    const saved = resolveInstallSettings({}, {}, local);
    expect(saved.dispatcherUrl).toBe("http://saved:8790");

    const defaults = resolveInstallSettings({}, {}, { configPath: "/c.yaml" });
    expect(defaults.dispatcherUrl).toBe(DEFAULT_DISPATCHER_URL);
    expect(defaults.runnerHost).toBe(DEFAULT_RUNNER_HOST);
  });

  it("writes every resolved setting and a working directory into the plist", () => {
    const settings = resolveInstallSettings(
      { dispatcherUrl: "http://cloud:8790", runnerHost: "0.0.0.0" },
      { EBBGATE_GATEWAY_URL: "http://gw/paperclip" },
      { configPath: "/Users/me/ebbgate.yaml" },
    );
    const xml = buildLaunchAgentPlist({
      node: "mini",
      settings,
      env: { PATH: "/usr/bin", HOME: "/Users/me" },
      nodeBin: "/usr/local/bin/node",
      cliPath: "/opt/ebbgate/cli.js",
    });
    for (const expected of [
      "<key>EBBGATE_CONFIG</key>",
      "<string>/Users/me/ebbgate.yaml</string>",
      "<string>http://cloud:8790</string>",
      "<string>http://gw/paperclip</string>",
      "<key>EBBGATE_RUNNER_HOST</key>",
      "<string>0.0.0.0</string>",
      "<key>WorkingDirectory</key>",
      `<string>${EBBGATE_DIR}</string>`,
    ]) {
      expect(xml).toContain(expected);
    }
  });
});
